import { AcaadMetadata, AcaadMetadataSchema } from '../AcaadMetadata';
import { Schema } from 'effect';

export const OperationObjectSchema = Schema.Struct({
  tags: Schema.Array(Schema.String),
  summary: Schema.String,
  acaad: Schema.UndefinedOr(AcaadMetadataSchema),

  /* Unused/Unmapped */
  responses: Schema.Object,
  description: Schema.UndefinedOr(Schema.String),
  operationId: Schema.UndefinedOr(Schema.String),
  requestBody: Schema.UndefinedOr(Schema.Object)
});

export class OperationObject {
  public path: string;
  public method: string;
  public acaad?: AcaadMetadata;

  constructor(
    path: string,
    method: string,
    acaadFromReq: Schema.Schema.Type<typeof AcaadMetadataSchema> | undefined
  ) {
    this.path = path;
    this.method = method;
    this.acaad = acaadFromReq ? AcaadMetadata.fromSchema(path, method, acaadFromReq) : undefined;
  }

  public static fromSchema(
    schema: Schema.Schema.Type<typeof OperationObjectSchema>,
    path: string,
    method: string
  ): OperationObject {
    return new OperationObject(path, method, schema.acaad);
  }
}
