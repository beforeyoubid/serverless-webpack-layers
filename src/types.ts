import Serverless from 'serverless';
import { Output } from 'serverless/aws';

export type Maybe<T> = null | undefined | T;
export const notEmpty = <TValue>(value: Maybe<TValue>): value is TValue => value !== null && value !== undefined;
export type Layer = {
  path: string;
  name: string;
  description?: string;
  retain?: boolean;
};
export type FunctionLayerReference = {
  Ref: string;
};
export type FunctionWithConfig = Serverless.FunctionDefinitionHandler & {
  layers?: FunctionLayerReference[];
  entry: string | string[];
  shouldLayer?: boolean;
  forceInclude?: string[];
  forceExclude?: string[];
};

export const isFunctionDefinition = (
  value: Serverless.FunctionDefinitionHandler | Serverless.FunctionDefinitionImage
): value is FunctionWithConfig => notEmpty(value) && Object.prototype.hasOwnProperty.call(value, 'handler');

export type TransformedLayerResources = { exportedLayers: Output[]; upgradedLayerReferences: FunctionLayerReference[] };
