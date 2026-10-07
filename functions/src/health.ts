import { onRequest } from 'firebase-functions/v2/https';

import { FUNCTIONS_REGION } from './config';

export type HealthResponse = { status: 'ok' };

/** 死活確認用の HTTPS 関数。GET のみ受け付ける */
export const health = onRequest({ region: FUNCTIONS_REGION }, (req, res) => {
  if (req.method !== 'GET') {
    res.set('Allow', 'GET').status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const body: HealthResponse = { status: 'ok' };
  res.status(200).json(body);
});
