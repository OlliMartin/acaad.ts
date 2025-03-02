import { Schema } from 'effect';

export const AcaadInfoMetadataSchema = Schema.Struct({
  name: Schema.String,
  os: Schema.String,
  otlpEnabled: Schema.Boolean
});

export interface AcaadInfoMetadataDefinition extends Schema.Schema.Type<typeof AcaadInfoMetadataSchema> {}

export class AcaadInfoMetadata {
  public name: string;
  public operatingSystem: string;
  public otlpEnabled: boolean;

  public constructor(name: string, operatingSystem: string, otlpEnabled: boolean) {
    this.name = name;
    this.operatingSystem = operatingSystem;
    this.otlpEnabled = otlpEnabled;
  }

  public static fromSchema(metadata: AcaadInfoMetadataDefinition) {
    return new AcaadInfoMetadata(metadata.name, metadata.os, metadata.otlpEnabled);
  }
}
