import Serverless from 'serverless';
import { Maybe, FunctionWithConfig } from './types';

import { exec as execNonPromise, ExecOptions, ExecException } from 'child_process';
import util from 'util';

export const notEmpty = <TValue>(value: Maybe<TValue>): value is TValue => value !== null && value !== undefined;

export const isFunctionDefinition = (
  value: Serverless.FunctionDefinitionHandler | Serverless.FunctionDefinitionImage
): value is FunctionWithConfig => notEmpty(value) && Object.prototype.hasOwnProperty.call(value, 'handler');

export const exec = util.promisify(
  (
    command: string,
    options: {
      encoding: 'buffer' | null;
    } & ExecOptions,
    callback: (error: ExecException | null, stdout: Buffer, stderr: Buffer) => void
  ) => execNonPromise(command, options, callback)
);
