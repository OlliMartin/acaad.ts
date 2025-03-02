import { PathItemObject, PathItemObjectSchema } from './PathItemObject';
import { pipe, Schema, Stream } from 'effect';
import { InfoObject, InfoObjectSchema } from './InfoObject';
import { AcaadMetadata } from '../AcaadMetadata';
import { OperationObject } from './OperationObject';
import { AcaadHost } from '../connection';

export const OpenApiDefinitionSchema = Schema.Struct({
  openapi: Schema.String,
  info: InfoObjectSchema,
  paths: Schema.Record({
    key: Schema.String,
    value: PathItemObjectSchema
  }),
  components: Schema.Any,
  tags: Schema.Any
});

export interface SchemaDefinition extends Schema.Schema.Type<typeof OpenApiDefinitionSchema> {}

export interface OpenApiDef {
  info: InfoObject;
  paths: PathItemObject[];
}

export class OpenApiDefinition implements OpenApiDef {
  info: InfoObject;
  paths: PathItemObject[];

  constructor(info: InfoObject, paths: PathItemObject[]) {
    this.info = info;
    this.paths = paths;
  }

  public static fromSchema(schema: SchemaDefinition): OpenApiDefinition {
    return new OpenApiDefinition(
      InfoObject.fromSchema(schema.info),
      Object.entries(schema.paths).map(([key, value]) => PathItemObject.fromSchema(key, value))
    );
  }
}

export type AcaadHostMapping = { host: AcaadHost };

export type AcaadServerMetadata = OpenApiDef & AcaadHostMapping;

export type AcaadPopulatedMetadata = AcaadMetadata & { serverMetadata: AcaadServerMetadata };

function _w(method: string, operationObject?: OperationObject) {
  return {
    method,
    operationObject
  };
}

export function getAcaadMetadata(serverMetadata: AcaadServerMetadata): Stream.Stream<AcaadPopulatedMetadata> {
  return pipe(
    Stream.fromIterable(serverMetadata.paths),
    // TODO: Error prone; Add all possible http methods
    Stream.flatMap((pathItemObject) =>
      Stream.fromIterable([_w('get', pathItemObject.get), _w('post', pathItemObject.post)])
    ),
    Stream.filter((op) => !!op?.operationObject?.acaad),
    Stream.map((op) => ({ ...op!.operationObject!.acaad, serverMetadata }) as AcaadPopulatedMetadata)
  );
}
