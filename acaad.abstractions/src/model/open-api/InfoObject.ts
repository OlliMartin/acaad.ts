import { Schema } from 'effect';
import { AcaadInfoMetadata, AcaadInfoMetadataSchema } from '../AcaadInfoMetadata';

export const InfoObjectSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  version: Schema.String,
  acaad: Schema.String,
  'acaad.metadata': AcaadInfoMetadataSchema
});

export interface InfoObjectDefinition extends Schema.Schema.Type<typeof InfoObjectSchema> {}

export class InfoObject {
  constructor(
    public title: string,
    public version: string,
    public acaad: string,
    public acaadMetadata: AcaadInfoMetadata
  ) {}

  static fromSchema(infoObject: InfoObjectDefinition): InfoObject {
    return new InfoObject(
      infoObject.title,
      infoObject.version,
      infoObject.acaad,
      AcaadInfoMetadata.fromSchema(infoObject['acaad.metadata'])
    );
  }
}
