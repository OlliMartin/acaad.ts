import { AcaadOutcome, ComponentType, ComponentCommandOutcomeEvent } from '@acaad/abstractions';
import { MockedComponentDescriptor } from '@acaad/testing/src/api/types';

export class TestEventFactory {
  public static createComponentOutcomeEvent(
    componentName: string,
    componentType: ComponentType = ComponentType.Sensor,
    outcomeRaw: string = 'test-outcome'
  ) {
    return ComponentCommandOutcomeEvent.Create(
      componentType,
      componentName,
      new AcaadOutcome({
        success: true,
        outcomeRaw: outcomeRaw
      })
    );
  }

  public static createSwitchOutcomeEventForState(
    componentDescriptor: MockedComponentDescriptor,
    targetState: boolean
  ): ComponentCommandOutcomeEvent {
    if (!componentDescriptor.onIff) {
      throw new Error('OnIff is not populated. This strongly indicates invalid test setup.');
    }

    return ComponentCommandOutcomeEvent.Create(
      ComponentType.Switch,
      componentDescriptor.toIdentifier(),
      new AcaadOutcome({
        success: true,
        outcomeRaw: targetState ? componentDescriptor.onIff.toString() : 'not-the-on-iff-value'
      })
    );
  }
}
