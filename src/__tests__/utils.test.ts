import Serverless from 'serverless';
import { notEmpty, isFunctionDefinition } from '../utils';

describe('notEmpty', () => {
  it('should false for null', () => {
    expect(notEmpty(null)).toEqual(false);
  });
  it('should false for undefined', () => {
    expect(notEmpty(undefined)).toEqual(false);
  });
  it('should true for number', () => {
    expect(notEmpty(Math.random())).toEqual(true);
  });
});

describe('isFunctionDefinition', () => {
  it('should return false if null', () => {
    expect(isFunctionDefinition(null as unknown as Serverless.FunctionDefinitionHandler)).toEqual(false);
  });
  it('should return false if undefined', () => {
    expect(isFunctionDefinition(undefined as unknown as Serverless.FunctionDefinitionHandler)).toEqual(false);
  });
  it('should return true if including a handler property', () => {
    expect(isFunctionDefinition({ handler: '' } as unknown as Serverless.FunctionDefinitionHandler)).toEqual(true);
  });
});
