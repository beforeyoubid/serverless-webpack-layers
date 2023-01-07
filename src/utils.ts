import Serverless from 'serverless';
import { Maybe, FunctionWithConfig } from './types';

export const notEmpty = <TValue>(value: Maybe<TValue>): value is TValue => value !== null && value !== undefined;

export const isFunctionDefinition = (
  value: Serverless.FunctionDefinitionHandler | Serverless.FunctionDefinitionImage
): value is FunctionWithConfig => notEmpty(value) && Object.prototype.hasOwnProperty.call(value, 'handler');
