import { Schema } from 'effect';
import { AcaadHost } from '../connection';

export const AcaadEventSchema = Schema.Struct({
  topic: Schema.String,
  type: Schema.String,
  name: Schema.String
});

// TODO: Make abstract
export class AcaadEvent {
  public topic: string;
  public type: string;
  public name: string;

  public constructor(topic: string, type: string, name: string) {
    this.topic = topic;
    this.type = type;
    this.name = name;
  }

  public toString(): string {
    return `${this.topic}:${this.type}:${this.name}`;
  }
}

export type AcaadPopulatedEvent = AcaadEvent & { host: AcaadHost };
