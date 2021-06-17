/*
 * Copyright 2021 gRPC authors.
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
 */

// This is a non-public, unstable API, but it's very convenient
import { loadProtosWithOptionsSync } from '@grpc/proto-loader/build/src/util';
import { experimental } from '@grpc/grpc-js';
import { Any__Output } from './generated/google/protobuf/Any';
import Filter = experimental.Filter;
import FilterFactory = experimental.FilterFactory;
import { TypedStruct__Output } from './generated/udpa/type/v1/TypedStruct';

const TYPED_STRUCT_URL = 'type.googleapis.com/udpa.type.v1.TypedStruct';
const TYPED_STRUCT_NAME = 'udpa.type.v1.TypedStruct';

const resourceRoot = loadProtosWithOptionsSync([
  'udpa/type/v1/typed_struct.proto'], {
    keepCase: true,
    includeDirs: [
      // Paths are relative to src/build
      __dirname + '/../../deps/udpa/'
    ],
  }
);

export interface HttpFilterConfig {
  typeUrl: string;
  config: any;
}

export interface HttpFilterFactoryConstructor<FilterType extends Filter> {
  new(config: any, overrideConfig: any): FilterFactory<FilterType>;
}

export interface HttpFilterRegistryEntry {
  parseFilterConfig(encodedConfig: Any__Output): HttpFilterConfig;
  parseFilterOverrideConfig(encodedConfig: Any__Output): HttpFilterConfig;
  httpFilterConstructor: HttpFilterFactoryConstructor<Filter>;
}

const FILTER_REGISTRY = new Map<string, HttpFilterRegistryEntry>();

export function registerHttpFilter(typeName: string, entry: HttpFilterRegistryEntry) {
  FILTER_REGISTRY.set(typeName, entry);
}

const toObjectOptions = {
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
}

export function parseFilterConfig(encodedConfig: Any__Output) {
  let typeUrl: string;
  if (encodedConfig.type_url === TYPED_STRUCT_URL) {
    const typedStructType = resourceRoot.lookup(TYPED_STRUCT_NAME);
    if (typedStructType) {
      const decodedMessage = (typedStructType as any).decode(encodedConfig.value);
      const messageObject = decodedMessage.$type.toObject(decodedMessage, toObjectOptions) as TypedStruct__Output;
      typeUrl = messageObject.type_url;
    } else {
      throw new Error('Failed to decode TypedStruct message');
    }
  } else {
    typeUrl = encodedConfig.type_url;
  }
  const registryEntry = FILTER_REGISTRY.get(typeUrl);
  if (registryEntry) {
    return registryEntry.parseFilterConfig(encodedConfig);
  } else {
    throw new Error(`Filter type URL ${typeUrl} not found in HTTP filter registry`);
  }
}