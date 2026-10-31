import type { NodeTypes } from '@xyflow/react';
import { NodeCard } from './NodeCard';

export const nodeTypes: NodeTypes = {
  text: NodeCard,
  image: NodeCard,
  video: NodeCard,
  audio: NodeCard,
  script: NodeCard,
  note: NodeCard,
  group: NodeCard,
};
