// Builds the instance BVH of a plant scene off the main thread (09 spec section 12.13). See plantBvhProtocol.ts.

import { answerBuild, type BvhBuildRequest } from './plantBvhProtocol';

self.onmessage = (event: MessageEvent<BvhBuildRequest>): void => {
  const { answer, transfer } = answerBuild(event.data);
  (self as unknown as Worker).postMessage(answer, transfer);
};
