import { Effect, pipe, Schema } from 'effect';
import { map, mapLeft } from 'effect/Either';
import { OpenApiDefinition, OpenApiDefinitionSchema } from '../open-api';
import { AcaadError, CalloutError, ResponseSchemaError } from '../../errors';

export class OpenApiDefinitionFactory {
  public static verifyResponsePayload = (
    data: unknown,
    onExcessProperty: 'ignore' | 'error' | 'preserve' = 'ignore'
  ): Effect.Effect<OpenApiDefinition, AcaadError> => {
    if (data) {
      const result = Schema.decodeUnknownEither(OpenApiDefinitionSchema)(data, {
        onExcessProperty
      });

      return pipe(
        result,
        mapLeft(
          (error) =>
            new ResponseSchemaError(
              'The server did not respond according to the acaad openapi extension. This is caused either by an incompatible version or another openapi json that was discovered.',
              error
            )
        ),
        map((val) => OpenApiDefinition.fromSchema(val))
      );
    }

    return Effect.fail(new CalloutError('No or invalid data received from the server.'));
  };
}
