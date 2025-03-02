import { AcaadOutcome } from './AcaadOutcome';
import { Option } from 'effect';

export interface InboundStateUpdate {
  originalOutcome: AcaadOutcome;

  determinedTargetState: Option.Option<unknown>;
}
