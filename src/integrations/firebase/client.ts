import { firebaseAuth } from './auth';
import { functionsBaseUrl } from './config';
import { firebaseFunctions } from './functions';
import { from } from './query';

export const db = {
  auth: firebaseAuth,
  from,
  functions: firebaseFunctions,
};

export { functionsBaseUrl };
