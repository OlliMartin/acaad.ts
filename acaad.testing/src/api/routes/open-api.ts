import { IComponentConfiguration, IMockedComponentModel, MockedComponentDescriptor } from '../types';
import {
  ComponentDescriptor,
  InfoObjectDefinition as AcaadInfoObjectAbstr,
  ComponentType
} from '@acaad/abstractions';
import { getTestLogger } from '../../utility';
import { OpenAPIV3 } from 'openapi-types';

import Document = OpenAPIV3.Document;
import PathsObject = OpenAPIV3.PathsObject;
import PathItemObject = OpenAPIV3.PathItemObject;
import { InfoObjectDefinition } from '@acaad/abstractions/src/model/open-api/InfoObject';

type AcaadDocument = Document & { info: AcaadInfoObjectAbstr };

const defaultEndpointProps = {
  tags: [],
  summary: 'Mock Summary',
  description: 'Mock Description',
  responses: {
    200: {
      'application/json': {
        examples: {
          success: {
            empty: 'string'
          }
        }
      }
    },
    400: {
      'application/json': {
        examples: {
          success: {
            empty: 'string'
          }
        }
      }
    },
    403: {
      'application/json': {
        examples: {
          success: {
            empty: 'string'
          }
        }
      }
    },
    500: {
      'application/json': {
        examples: {
          success: {
            empty: 'string'
          }
        }
      }
    }
  }
};

function getSensorComponent(cd: ComponentDescriptor): PathItemObject {
  const path = `/components/${cd.toIdentifier()}`;

  return {
    [path]: {
      get: {
        ...defaultEndpointProps,
        operationId: path,
        acaad: {
          component: {
            name: `${cd.toIdentifier()}`,
            type: 'sensor'
          },
          queryable: true
        }
      }
    }
  };
}

function getButtonComponent(cd: ComponentDescriptor): PathItemObject {
  const path = `/components/${cd.toIdentifier()}`;

  return {
    [path]: {
      post: {
        ...defaultEndpointProps,
        operationId: path,
        acaad: {
          component: {
            name: `${cd.toIdentifier()}`,
            type: 'button'
          },
          actionable: true
        }
      }
    }
  };
}

function getSwitchComponent(cd: MockedComponentDescriptor): PathItemObject {
  const path = `/components/${cd.toIdentifier()}`;

  return {
    [path]: {
      get: {
        ...defaultEndpointProps,
        operationId: path,
        acaad: {
          component: {
            name: `${cd.toIdentifier()}`,
            type: 'switch'
          },
          onIff: cd.onIff ?? true,
          queryable: true
        }
      }
    },
    [`${path}/on`]: {
      post: {
        ...defaultEndpointProps,
        operationId: `${path}/on`,
        acaad: {
          component: {
            name: `${cd.toIdentifier()}`,
            type: 'switch'
          },
          onIff: cd.onIff ?? true,
          actionable: true,
          forValue: true
        }
      }
    },
    [`${path}/off`]: {
      post: {
        ...defaultEndpointProps,
        operationId: `${path}/off`,
        acaad: {
          component: {
            name: `${cd.toIdentifier()}`,
            type: 'switch'
          },
          onIff: cd.onIff ?? true,
          actionable: true,
          forValue: false
        }
      }
    }
  };
}

function getOpenApiWrapper(pathObj: PathsObject<string, PathItemObject>): AcaadDocument {
  return {
    openapi: '3.0.0',
    info: {
      title: 'OpenAPI',
      description: '[MOCK] API for discovering and interacting with Components.',
      version: '1.0.0',
      acaad: 'commit-hash',
      'acaad.metadata': {
        name: 'mock.acaad',
        os: 'windows',
        otlpEnabled: false
      }
    },
    paths: pathObj
  };
}

function getGeneratedBody(componentModel: IMockedComponentModel) {
  const log = getTestLogger('open-api-route');

  const startMs = Date.now();

  const sensorObj: PathsObject<string, PathItemObject> = (componentModel.sensors ?? []).reduce(
    (prev: object, cd, idx) => ({
      ...prev,
      ...getSensorComponent(cd)
    }),
    {}
  );

  const buttonObj: PathsObject<string, PathItemObject> = (componentModel.buttons ?? []).reduce(
    (prev: object, cd, idx) => ({
      ...prev,
      ...getButtonComponent(cd)
    }),
    {}
  );

  const switchObj: PathsObject<string, PathItemObject> = (componentModel.switches ?? []).reduce(
    (prev: object, cd, idx) => ({
      ...prev,
      ...getSwitchComponent(cd)
    }),
    {}
  );

  const pathObj: PathsObject<string, PathItemObject> = {
    ...sensorObj,
    ...buttonObj,
    ...switchObj
  };

  log(`Generated path object in ${Date.now() - startMs}ms.`);

  return getOpenApiWrapper(pathObj);
}

function openApi(componentModel: IMockedComponentModel) {
  const generatedBody = getGeneratedBody(componentModel);
  const realisticBody = getRealisticScenario();

  const generatedVariant = {
    id: 'generated', // id of the variant
    type: 'json', // variant type
    options: {
      status: 200,
      body: generatedBody
    }
  };

  const missingAcaadMetadata = {
    ...generatedVariant,
    id: 'missing-acaad-metadata',
    options: {
      status: 200,
      body: {
        ...generatedBody,
        info: {
          ...generatedBody.info,
          acaad: undefined
        }
      }
    }
  };

  const emptyResponse = {
    id: 'empty-response', // id of the variant
    type: 'json', // variant type
    options: {
      status: 200,
      body: {}
    }
  };

  const realisticVariant = {
    id: 'realistic', // id of the variant
    type: 'json', // variant type
    options: {
      status: 200,
      body: realisticBody
    }
  };

  const errorResponses = [
    {
      id: '400-status',
      type: 'json',
      options: {
        status: 400,
        body: generatedBody
      }
    },
    {
      id: '403-status',
      type: 'json',
      options: {
        status: 403,
        body: generatedBody
      }
    },
    {
      id: '500-status',
      type: 'json',
      options: {
        status: 500,
        body: generatedBody
      }
    }
  ];

  const route = [
    {
      id: 'openApi', // id of the route
      url: '/openapi/v1.json', // url in path-to-regexp format
      method: 'GET', // HTTP method
      variants: [generatedVariant, missingAcaadMetadata, emptyResponse, realisticVariant, ...errorResponses]
    }
  ];

  return { route, generatedBody, realisticBody };
}

function _cd2Str(componentName: string): ComponentDescriptor {
  return new ComponentDescriptor(componentName);
}

export const realisticComponentDefinition: [ComponentType, string][] = [
  [ComponentType.Sensor, 'acaad.usage.cpu'],
  [ComponentType.Sensor, 'acaad.usage.ram'],

  [ComponentType.Button, 'acaad.ctrl.shutdown'],
  [ComponentType.Button, 'acaad.ctrl.reboot'],

  [ComponentType.Sensor, 'ping.google'],
  [ComponentType.Sensor, 'ping.xkcd'],

  [ComponentType.Button, 'media.play'],
  [ComponentType.Button, 'media.pause'],
  [ComponentType.Button, 'media.stop'],

  [ComponentType.Switch, 'active-audio-device'],
  [ComponentType.Switch, 'main-screen']
];

function mapToPathItemObject(componentDef: [ComponentType, string]): PathItemObject {
  const [type, name] = componentDef;

  if (type === ComponentType.Sensor) {
    return getSensorComponent(_cd2Str(name));
  } else if (type === ComponentType.Button) {
    return getButtonComponent(_cd2Str(name));
  } else if (type === ComponentType.Switch) {
    return getSwitchComponent(_cd2Str(name));
  } else {
    throw new Error(`Unknown component type ${type}. Cannot continue.`);
  }
}

function getRealisticScenario(): AcaadDocument {
  const test: PathsObject<string, PathItemObject> = realisticComponentDefinition.reduce(
    (prev, curr) => ({
      ...prev,
      ...mapToPathItemObject(curr)
    }),
    {}
  );

  return getOpenApiWrapper(test);
}

export default openApi;
