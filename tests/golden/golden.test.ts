import { describe } from 'vitest';
import { plans } from './plans';
import { describePlans } from './describePlans';

describe('golden replay corpus', () => describePlans(plans));
