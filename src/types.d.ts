import Serverless from 'serverless';
import { Output } from 'serverless/aws';

export type Maybe<T> = null | undefined | T;

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

export type TransformedLayerResources = { exportedLayers: Output[]; upgradedLayerReferences: FunctionLayerReference[] };
export type Packager = 'npm' | 'yarn' | 'pnpm';
