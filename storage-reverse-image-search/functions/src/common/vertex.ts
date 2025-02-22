/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as admin from 'firebase-admin';

import {protos} from '@google-cloud/aiplatform';
import {v1beta1 as aiplatform} from '@google-cloud/aiplatform';

import axios, {AxiosError} from 'axios';

import config from '../config';
import {Query} from '../types/query';
import {getAccessToken} from './utils';
import {IndexStatus} from '../types/index_status';
import {AlgorithmConfig} from '../types/algorithm_config';

const apiEndpoint = `${config.location}-aiplatform.googleapis.com`;

export const indexClient = new aiplatform.IndexServiceClient({
  apiEndpoint: apiEndpoint,
  fallback: 'rest',
});
export const indexEndpointClient = new aiplatform.IndexEndpointServiceClient({
  apiEndpoint: apiEndpoint,
  fallback: 'rest',
});

/**
 * Creates an index in Vertex AI.
 * @param dimensions The number of dimensions of the index.
 * @returns {Promise<string | undefined>} The long-running operation name.
 * @throws {Error} If the operation fails.
 */
export async function createIndex(
  dimensions: number
): Promise<string | undefined> {
  const algorithmConfig =
    config.algorithmConfig === AlgorithmConfig.BruteForceConfig
      ? {
          structValue: {
            fields: {
              bruteForceConfig: {
                structValue: {
                  fields: {},
                },
              },
            },
          },
        }
      : {
          structValue: {
            fields: {
              treeAhConfig: {
                structValue: {
                  fields: {
                    // TODO mais - add treeAHConfig https://cloud.google.com/vertex-ai/docs/matching-engine/configuring-indexes#tree-ah-config
                  },
                },
              },
            },
          },
        };
  const metadata = {
    structValue: {
      fields: {
        contentsDeltaUri: {
          stringValue: `gs://${config.bucketName}/datapoints`,
        },
        isCompleteOverwrite: {boolValue: false},
        config: {
          structValue: {
            fields: {
              dimensions: {
                numberValue: dimensions,
              },
              // TODO make this configurable
              approximateNeighborsCount: {numberValue: config.neighbors},
              distanceMeasureType: {stringValue: config.distanceMeasureType},
              featureNormType: {stringValue: config.featureNormType},
              algorithmConfig: {},
            },
          },
        },
      },
    },
  };

  metadata.structValue.fields.config.structValue.fields.algorithmConfig =
    algorithmConfig;

  const [operation] = await indexClient.createIndex({
    parent: `projects/${config.projectId}/locations/${config.location}`,
    index: {
      name: 'ext-' + config.instanceId,
      displayName: 'Storage Image Similarity Extension',
      indexUpdateMethod: 'STREAM_UPDATE',
      metadataSchemaUri:
        'gs://google-cloud-aiplatform/schema/matchingengine/metadata/nearest_neighbor_search_1.0.0.yaml',
      metadata: metadata,
    },
  });

  // We cannot await the operation here because it will take longer than the Function timeout.
  if (operation.error) {
    throw new Error(operation.error.message);
  }

  return operation.name;
}

export async function createIndexEndpoint() {
  const [operation] = await indexEndpointClient.createIndexEndpoint({
    parent: `projects/${config.projectId}/locations/${config.location}`,
    indexEndpoint: {
      name: 'ext-' + config.instanceId + '-endpoint',
      displayName: 'Firestore Text Similarity Extension',
      publicEndpointEnabled: true,
    },
  });

  return operation;
}

/**
 *
 * @param indexEndpoint format: projects/{project}/locations/{location}/indexEndpoints/{index_endpoint}
 * @param index format: projects/{project}/locations/{location}/indexes/{index}
 */
export async function deployIndex(indexEndpoint: string, index: string) {
  const [operation] = await indexEndpointClient.deployIndex({
    indexEndpoint: indexEndpoint,
    deployedIndex: {
      id: `ext_${config.instanceId.replace(/-/g, '_')}_index`,
      index: index,
    },
  });

  if (operation.error) {
    throw new Error(operation.error.message);
  }

  return operation.name;
}

/**
 *
 * @param indexResourceName format: projects/{project}/locations/{location}/indexes/{index}
 * @param datapoints a list of datapoints to upsert.
 * @returns {Promise<protos.google.longrunning.IOperation>}
 */
export async function upsertDatapoint(
  indexResourceName: string,
  datapoints: {
    datapoint_id: string;
    feature_vector: number[];
  }[]
) {
  await axios.post(
    `https://${apiEndpoint}/v1beta1/${indexResourceName}:upsertDatapoints`,
    {
      datapoints: datapoints,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await getAccessToken()}`,
      },
    }
  );
}

export async function removeDatapoint(
  indexResourceName: string,
  datapoints: string[]
) {
  await axios.post(
    `https://${apiEndpoint}/v1beta1/${indexResourceName}:removeDatapoints`,
    {
      datapoint_ids: datapoints,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await getAccessToken()}`,
      },
    }
  );
}

export async function queryIndex(
  queries: Query[],
  searchResults: number,
  endpoint: string,
  indexEndpoint: string
) {
  try {
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `https://${endpoint}/v1beta1/projects/${config.projectId}/locations/${config.location}/indexEndpoints/${indexEndpoint}:findNeighbors`,
      {
        queries: queries.map(query => query.toVertexQuery()),
        deployed_index_id: `ext_${config.instanceId.replace(/-/g, '_')}_index`,
        neighbor_count: searchResults,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error calling the endpoint:', error);
    throw error;
  }
}

/**
 * Get the public endpoint domain name of an IndexEndpoint.
 *
 * @param indexEndpoint format: projects/{project}/locations/{location}/indexEndpoints/{index_endpoint}
 * @returns {Promise<string>} the public endpoint domain name
 */
export async function getDeployedIndex(indexEndpoint: string): Promise<string> {
  const [operation] = await indexEndpointClient.getIndexEndpoint({
    name: indexEndpoint,
  });

  if (!operation.publicEndpointDomainName) {
    throw new Error(
      `IndexEndpoint ${indexEndpoint} is not deployed or doesn't have a public endpoint.`
    );
  }

  return operation.publicEndpointDomainName;
}

export async function getOperationByName(
  operationName: string
): Promise<protos.google.longrunning.Operation> {
  try {
    const accessToken = await getAccessToken();

    const response = await axios.get(
      `https://${apiEndpoint}/v1beta1/${operationName}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    throw (error as AxiosError).response?.data;
  }
}

export async function cancelOperationByName(operationName: string) {
  try {
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `https://${apiEndpoint}/v1beta1/${operationName}:cancel`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    throw (error as AxiosError).response?.data;
  }
}

export async function deleteOperationByName(operationName: string) {
  try {
    const accessToken = await getAccessToken();

    const response = await axios.delete(
      `https://${apiEndpoint}/v1beta1/${operationName}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    throw (error as AxiosError).response?.data;
  }
}

export async function checkIndexStatus(): Promise<{
  status?: IndexStatus;
  index?: string;
  indexEndpoint?: string;
}> {
  const metdata = await admin.firestore().doc(config.metadataDoc).get();
  return metdata.data() ?? {};
}
