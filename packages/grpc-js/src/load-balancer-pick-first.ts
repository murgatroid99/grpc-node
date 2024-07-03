/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import {
  LoadBalancer,
  ChannelControlHelper,
  TypedLoadBalancingConfig,
  registerDefaultLoadBalancerType,
  registerLoadBalancerType,
  createChildChannelControlHelper,
} from './load-balancer';
import { ConnectivityState } from './connectivity-state';
import {
  QueuePicker,
  Picker,
  PickArgs,
  CompletePickResult,
  PickResultType,
  UnavailablePicker,
} from './picker';
import { Endpoint, SubchannelAddress, subchannelAddressToString } from './subchannel-address';
import * as logging from './logging';
import { LogVerbosity } from './constants';
import {
  SubchannelInterface,
  ConnectivityStateListener,
  HealthListener,
} from './subchannel-interface';
import { isTcpSubchannelAddress } from './subchannel-address';
import { isIPv6 } from 'net';
import { ChannelOptions } from './channel-options';

const TRACER_NAME = 'pick_first';

function trace(text: string): void {
  logging.trace(LogVerbosity.DEBUG, TRACER_NAME, text);
}

const TYPE_NAME = 'pick_first';

/**
 * Delay after starting a connection on a subchannel before starting a
 * connection on the next subchannel in the list, for Happy Eyeballs algorithm.
 */
const CONNECTION_DELAY_INTERVAL_MS = 250;

export class PickFirstLoadBalancingConfig implements TypedLoadBalancingConfig {
  constructor(private readonly shuffleAddressList: boolean) {}

  getLoadBalancerName(): string {
    return TYPE_NAME;
  }

  toJsonObject(): object {
    return {
      [TYPE_NAME]: {
        shuffleAddressList: this.shuffleAddressList,
      },
    };
  }

  getShuffleAddressList() {
    return this.shuffleAddressList;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static createFromJson(obj: any) {
    if (
      'shuffleAddressList' in obj &&
      !(typeof obj.shuffleAddressList === 'boolean')
    ) {
      throw new Error(
        'pick_first config field shuffleAddressList must be a boolean if provided'
      );
    }
    return new PickFirstLoadBalancingConfig(obj.shuffleAddressList === true);
  }
}

/**
 * Picker for a `PickFirstLoadBalancer` in the READY state. Always returns the
 * picked subchannel.
 */
class PickFirstPicker implements Picker {
  constructor(private subchannel: SubchannelInterface) {}

  pick(pickArgs: PickArgs): CompletePickResult {
    return {
      pickResultType: PickResultType.COMPLETE,
      subchannel: this.subchannel,
      status: null,
      onCallStarted: null,
      onCallEnded: null,
    };
  }
}

interface SubchannelChild {
  subchannel: SubchannelInterface;
  hasReportedTransientFailure: boolean;
}

/**
 * Return a new array with the elements of the input array in a random order
 * @param list The input array
 * @returns A shuffled array of the elements of list
 */
export function shuffled<T>(list: T[]): T[] {
  const result = list.slice();
  for (let i = result.length - 1; i > 1; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

/**
 * Interleave addresses in addressList by family in accordance with RFC-8304 section 4
 * @param addressList
 * @returns
 */
function interleaveAddressFamilies(
  addressList: SubchannelAddress[]
): SubchannelAddress[] {
  const result: SubchannelAddress[] = [];
  const ipv6Addresses: SubchannelAddress[] = [];
  const ipv4Addresses: SubchannelAddress[] = [];
  const ipv6First =
    isTcpSubchannelAddress(addressList[0]) && isIPv6(addressList[0].host);
  for (const address of addressList) {
    if (isTcpSubchannelAddress(address) && isIPv6(address.host)) {
      ipv6Addresses.push(address);
    } else {
      ipv4Addresses.push(address);
    }
  }
  const firstList = ipv6First ? ipv6Addresses : ipv4Addresses;
  const secondList = ipv6First ? ipv4Addresses : ipv6Addresses;
  for (let i = 0; i < Math.max(firstList.length, secondList.length); i++) {
    if (i < firstList.length) {
      result.push(firstList[i]);
    }
    if (i < secondList.length) {
      result.push(secondList[i]);
    }
  }
  return result;
}

const REPORT_HEALTH_STATUS_OPTION_NAME =
  'grpc-node.internal.pick-first.report_health_status';

export class PickFirstLoadBalancer implements LoadBalancer {
  /**
   * The list of subchannels this load balancer is currently attempting to
   * connect to.
   */
  private children: SubchannelChild[] = [];
  /**
   * The current connectivity state of the load balancer.
   */
  private currentState: ConnectivityState = ConnectivityState.IDLE;
  /**
   * The index within the `subchannels` array of the subchannel with the most
   * recently started connection attempt.
   */
  private currentSubchannelIndex = 0;
  /**
   * The currently picked subchannel used for making calls. Populated if
   * and only if the load balancer's current state is READY. In that case,
   * the subchannel's current state is also READY.
   */
  private currentPick: SubchannelInterface | null = null;
  /**
   * Listener callback attached to each subchannel in the `subchannels` list
   * while establishing a connection.
   */
  private subchannelStateListener: ConnectivityStateListener = (
    subchannel,
    previousState,
    newState,
    keepaliveTime,
    errorMessage
  ) => {
    this.onSubchannelStateUpdate(
      subchannel,
      previousState,
      newState,
      errorMessage
    );
  };

  private pickedSubchannelHealthListener: HealthListener = () =>
    this.calculateAndReportNewState();
  /**
   * Timer reference for the timer tracking when to start
   */
  private connectionDelayTimeout: NodeJS.Timeout;

  private triedAllSubchannels = false;

  /**
   * The LB policy enters sticky TRANSIENT_FAILURE mode when all
   * subchannels have failed to connect at least once, and it stays in that
   * mode until a connection attempt is successful. While in sticky TF mode,
   * the LB policy continuously attempts to connect to all of its subchannels.
   */
  private stickyTransientFailureMode = false;

  private reportHealthStatus: boolean;

  /**
   * Indicates whether we called channelControlHelper.requestReresolution since
   * the last call to updateAddressList
   */
  private requestedResolutionSinceLastUpdate = false;

  /**
   * The most recent error reported by any subchannel as it transitioned to
   * TRANSIENT_FAILURE.
   */
  private lastError: string | null = null;

  private latestAddressList: SubchannelAddress[] | null = null;

  /**
   * Load balancer that attempts to connect to each backend in the address list
   * in order, and picks the first one that connects, using it for every
   * request.
   * @param channelControlHelper `ChannelControlHelper` instance provided by
   *     this load balancer's owner.
   */
  constructor(
    private readonly channelControlHelper: ChannelControlHelper,
    options: ChannelOptions
  ) {
    this.connectionDelayTimeout = setTimeout(() => {}, 0);
    clearTimeout(this.connectionDelayTimeout);
    this.reportHealthStatus = options[REPORT_HEALTH_STATUS_OPTION_NAME];
  }

  private allChildrenHaveReportedTF(): boolean {
    return this.children.every(child => child.hasReportedTransientFailure);
  }

  private calculateAndReportNewState() {
    if (this.currentPick) {
      if (this.reportHealthStatus && !this.currentPick.isHealthy()) {
        this.updateState(
          ConnectivityState.TRANSIENT_FAILURE,
          new UnavailablePicker({
            details: `Picked subchannel ${this.currentPick.getAddress()} is unhealthy`,
          })
        );
      } else {
        this.updateState(
          ConnectivityState.READY,
          new PickFirstPicker(this.currentPick)
        );
      }
    } else if (this.children.length === 0) {
      this.updateState(ConnectivityState.IDLE, new QueuePicker(this));
    } else {
      if (this.stickyTransientFailureMode) {
        this.updateState(
          ConnectivityState.TRANSIENT_FAILURE,
          new UnavailablePicker({
            details: `No connection established. Last error: ${this.lastError}`,
          })
        );
      } else {
        this.updateState(ConnectivityState.CONNECTING, new QueuePicker(this));
      }
    }
  }

  private requestReresolution() {
    this.requestedResolutionSinceLastUpdate = true;
    this.channelControlHelper.requestReresolution();
  }

  private maybeEnterStickyTransientFailureMode() {
    if (!this.allChildrenHaveReportedTF()) {
      return;
    }
    if (!this.requestedResolutionSinceLastUpdate) {
      /* Each time we get an update we reset each subchannel's
       * hasReportedTransientFailure flag, so the next time we get to this
       * point after that, each subchannel has reported TRANSIENT_FAILURE
       * at least once since then. That is the trigger for requesting
       * reresolution, whether or not the LB policy is already in sticky TF
       * mode. */
      this.requestReresolution();
    }
    if (this.stickyTransientFailureMode) {
      return;
    }
    this.stickyTransientFailureMode = true;
    for (const { subchannel } of this.children) {
      subchannel.startConnecting();
    }
    this.calculateAndReportNewState();
  }

  private removeCurrentPick() {
    if (this.currentPick !== null) {
      /* Unref can cause a state change, which can cause a change in the value
       * of this.currentPick, so we hold a local reference to make sure that
       * does not impact this function. */
      const currentPick = this.currentPick;
      this.currentPick = null;
      currentPick.unref();
      currentPick.removeConnectivityStateListener(this.subchannelStateListener);
      this.channelControlHelper.removeChannelzChild(
        currentPick.getChannelzRef()
      );
      if (this.reportHealthStatus) {
        currentPick.removeHealthStateWatcher(
          this.pickedSubchannelHealthListener
        );
      }
    }
  }

  private onSubchannelStateUpdate(
    subchannel: SubchannelInterface,
    previousState: ConnectivityState,
    newState: ConnectivityState,
    errorMessage?: string
  ) {
    if (this.currentPick?.realSubchannelEquals(subchannel)) {
      if (newState !== ConnectivityState.READY) {
        this.removeCurrentPick();
        this.calculateAndReportNewState();
      }
      return;
    }
    for (const [index, child] of this.children.entries()) {
      if (subchannel.realSubchannelEquals(child.subchannel)) {
        if (newState === ConnectivityState.READY) {
          this.pickSubchannel(child.subchannel);
        }
        if (newState === ConnectivityState.TRANSIENT_FAILURE) {
          child.hasReportedTransientFailure = true;
          if (errorMessage) {
            this.lastError = errorMessage;
          }
          this.maybeEnterStickyTransientFailureMode();
          if (index === this.currentSubchannelIndex) {
            this.startNextSubchannelConnecting(index + 1);
          }
        }
        child.subchannel.startConnecting();
        return;
      }
    }
  }

  private startNextSubchannelConnecting(startIndex: number) {
    clearTimeout(this.connectionDelayTimeout);
    if (this.triedAllSubchannels) {
      return;
    }
    for (const [index, child] of this.children.entries()) {
      if (index >= startIndex) {
        const subchannelState = child.subchannel.getConnectivityState();
        if (
          subchannelState === ConnectivityState.IDLE ||
          subchannelState === ConnectivityState.CONNECTING
        ) {
          this.startConnecting(index);
          return;
        }
      }
    }
    this.triedAllSubchannels = true;
    this.maybeEnterStickyTransientFailureMode();
  }

  /**
   * Have a single subchannel in the `subchannels` list start connecting.
   * @param subchannelIndex The index into the `subchannels` list.
   */
  private startConnecting(subchannelIndex: number) {
    clearTimeout(this.connectionDelayTimeout);
    this.currentSubchannelIndex = subchannelIndex;
    if (
      this.children[subchannelIndex].subchannel.getConnectivityState() ===
      ConnectivityState.IDLE
    ) {
      trace(
        'Start connecting to subchannel with address ' +
          this.children[subchannelIndex].subchannel.getAddress()
      );
      process.nextTick(() => {
        this.children[subchannelIndex]?.subchannel.startConnecting();
      });
    }
    this.connectionDelayTimeout = setTimeout(() => {
      this.startNextSubchannelConnecting(subchannelIndex + 1);
    }, CONNECTION_DELAY_INTERVAL_MS);
    this.connectionDelayTimeout.unref?.();
  }

  private pickSubchannel(subchannel: SubchannelInterface) {
    if (this.currentPick && subchannel.realSubchannelEquals(this.currentPick)) {
      return;
    }
    trace('Pick subchannel with address ' + subchannel.getAddress());
    this.stickyTransientFailureMode = false;
    this.removeCurrentPick();
    this.currentPick = subchannel;
    subchannel.ref();
    if (this.reportHealthStatus) {
      subchannel.addHealthStateWatcher(this.pickedSubchannelHealthListener);
    }
    this.channelControlHelper.addChannelzChild(subchannel.getChannelzRef());
    this.resetSubchannelList();
    clearTimeout(this.connectionDelayTimeout);
    this.calculateAndReportNewState();
  }

  private updateState(newState: ConnectivityState, picker: Picker) {
    trace(
      ConnectivityState[this.currentState] +
        ' -> ' +
        ConnectivityState[newState]
    );
    this.currentState = newState;
    this.channelControlHelper.updateState(newState, picker);
  }

  private resetSubchannelList() {
    for (const child of this.children) {
      if (
        !(
          this.currentPick &&
          child.subchannel.realSubchannelEquals(this.currentPick)
        )
      ) {
        /* The connectivity state listener is the same whether the subchannel
         * is in the list of children or it is the currentPick, so if it is in
         * both, removing it here would cause problems. In particular, that
         * always happens immediately after the subchannel is picked. */
        child.subchannel.removeConnectivityStateListener(
          this.subchannelStateListener
        );
      }
      /* Refs are counted independently for the children list and the
       * currentPick, so we call unref whether or not the child is the
       * currentPick. Channelz child references are also refcounted, so
       * removeChannelzChild can be handled the same way. */
      child.subchannel.unref();
      this.channelControlHelper.removeChannelzChild(
        child.subchannel.getChannelzRef()
      );
    }
    this.currentSubchannelIndex = 0;
    this.children = [];
    this.triedAllSubchannels = false;
    this.requestedResolutionSinceLastUpdate = false;
  }

  private connectToAddressList(addressList: SubchannelAddress[]) {
    const newChildrenList = addressList.map(address => ({
      subchannel: this.channelControlHelper.createSubchannel(address, {}),
      hasReportedTransientFailure: false,
    }));
    trace('connectToAddressList([' + addressList.map(address => subchannelAddressToString(address)) + '])');
    for (const { subchannel } of newChildrenList) {
      if (subchannel.getConnectivityState() === ConnectivityState.READY) {
        this.pickSubchannel(subchannel);
        return;
      }
    }
    /* Ref each subchannel before resetting the list, to ensure that
     * subchannels shared between the list don't drop to 0 refs during the
     * transition. */
    for (const { subchannel } of newChildrenList) {
      subchannel.ref();
      this.channelControlHelper.addChannelzChild(subchannel.getChannelzRef());
    }
    this.resetSubchannelList();
    this.children = newChildrenList;
    for (const { subchannel } of this.children) {
      subchannel.addConnectivityStateListener(this.subchannelStateListener);
      if (subchannel.getConnectivityState() === ConnectivityState.READY) {
        this.pickSubchannel(subchannel);
        return;
      }
    }
    for (const child of this.children) {
      if (
        child.subchannel.getConnectivityState() ===
        ConnectivityState.TRANSIENT_FAILURE
      ) {
        child.hasReportedTransientFailure = true;
      }
    }
    this.startNextSubchannelConnecting(0);
    this.calculateAndReportNewState();
  }

  updateAddressList(
    endpointList: Endpoint[],
    lbConfig: TypedLoadBalancingConfig
  ): void {
    if (!(lbConfig instanceof PickFirstLoadBalancingConfig)) {
      return;
    }
    /* Previously, an update would be discarded if it was identical to the
     * previous update, to minimize churn. Now the DNS resolver is
     * rate-limited, so that is less of a concern. */
    if (lbConfig.getShuffleAddressList()) {
      endpointList = shuffled(endpointList);
    }
    const rawAddressList = ([] as SubchannelAddress[]).concat(
      ...endpointList.map(endpoint => endpoint.addresses)
    );
    trace('updateAddressList([' + rawAddressList.map(address => subchannelAddressToString(address)) + '])');
    if (rawAddressList.length === 0) {
      throw new Error('No addresses in endpoint list passed to pick_first');
    }
    const addressList = interleaveAddressFamilies(rawAddressList);
    this.latestAddressList = addressList;
    this.connectToAddressList(addressList);
  }

  exitIdle() {
    if (
      this.currentState === ConnectivityState.IDLE &&
      this.latestAddressList
    ) {
      this.connectToAddressList(this.latestAddressList);
    }
  }

  resetBackoff() {
    /* The pick first load balancer does not have a connection backoff, so this
     * does nothing */
  }

  destroy() {
    this.resetSubchannelList();
    this.removeCurrentPick();
  }

  getTypeName(): string {
    return TYPE_NAME;
  }
}

const LEAF_CONFIG = new PickFirstLoadBalancingConfig(false);

/**
 * This class handles the leaf load balancing operations for a single endpoint.
 * It is a thin wrapper around a PickFirstLoadBalancer with a different API
 * that more closely reflects how it will be used as a leaf balancer.
 */
export class LeafLoadBalancer {
  private pickFirstBalancer: PickFirstLoadBalancer;
  private latestState: ConnectivityState = ConnectivityState.IDLE;
  private latestPicker: Picker;
  constructor(
    private endpoint: Endpoint,
    channelControlHelper: ChannelControlHelper,
    options: ChannelOptions
  ) {
    const childChannelControlHelper = createChildChannelControlHelper(
      channelControlHelper,
      {
        updateState: (connectivityState, picker) => {
          this.latestState = connectivityState;
          this.latestPicker = picker;
          channelControlHelper.updateState(connectivityState, picker);
        },
      }
    );
    this.pickFirstBalancer = new PickFirstLoadBalancer(
      childChannelControlHelper,
      { ...options, [REPORT_HEALTH_STATUS_OPTION_NAME]: true }
    );
    this.latestPicker = new QueuePicker(this.pickFirstBalancer);
  }

  startConnecting() {
    this.pickFirstBalancer.updateAddressList([this.endpoint], LEAF_CONFIG);
  }

  /**
   * Update the endpoint associated with this LeafLoadBalancer to a new
   * endpoint. Does not trigger connection establishment if a connection
   * attempt is not already in progress.
   * @param newEndpoint
   */
  updateEndpoint(newEndpoint: Endpoint) {
    this.endpoint = newEndpoint;
    if (this.latestState !== ConnectivityState.IDLE) {
      this.startConnecting();
    }
  }

  getConnectivityState() {
    return this.latestState;
  }

  getPicker() {
    return this.latestPicker;
  }

  getEndpoint() {
    return this.endpoint;
  }

  exitIdle() {
    this.pickFirstBalancer.exitIdle();
  }

  destroy() {
    this.pickFirstBalancer.destroy();
  }
}

export function setup(): void {
  registerLoadBalancerType(
    TYPE_NAME,
    PickFirstLoadBalancer,
    PickFirstLoadBalancingConfig
  );
  registerDefaultLoadBalancerType(TYPE_NAME);
}
