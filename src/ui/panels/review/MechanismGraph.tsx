// Mechanism graph (FR-FPR-52): bodies as nodes rooted at the ground, joints as edges with their glyph (⟲ revolute, ⇕ prismatic, ● spherical),
// loop-closing joints dashed, gear couplings dotted with the ratio, a DOF badge and the problems in words. Clicking a body highlights it on
// the model (the same focus the Mechanisms panel uses, so the selection is shared).

import React, { useMemo } from 'react';
import { execute } from '@core/commands/registry';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useFocusStore } from '@ui/store/focusStore';
import { bodyFocus } from '@ui/panels/mechanismFocus';
import { buildMechanismGraph, type GraphEdge, type GraphNode } from './mechanismGraphModel';

const NODE_RADIUS = 9;

function Edge({ edge, nodes }: { edge: GraphEdge; nodes: ReadonlyMap<string, GraphNode> }): React.ReactElement | null {
  const [from, to] = [nodes.get(edge.from), nodes.get(edge.to)];
  if (from === undefined || to === undefined) return null;
  // a gear between bodies of one layer bows out so it does not hide a joint edge
  const bow = edge.kind === 'gear' ? 18 : 0;
  const [mx, my] = [(from.x + to.x) / 2, (from.y + to.y) / 2 + bow];
  return (
    <g className={`mechanism-graph__edge mechanism-graph__edge--${edge.kind}`} data-testid={`mechanism-edge-${edge.id}`}>
      <path d={`M${from.x},${from.y} Q${mx},${my + bow} ${to.x},${to.y}`} fill="none" />
      <text x={mx + 4} y={my} className="mechanism-graph__glyph">
        {edge.glyph} {edge.kind === 'gear' ? edge.label : ''}
      </text>
      <title>{`${edge.label} (${edge.kind === 'loop' ? 'closes a loop' : edge.kind === 'gear' ? 'gear coupling' : 'joint'})`}</title>
    </g>
  );
}

export function MechanismGraph(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const dynamics = document.dynamics;
  const focusItem = useFocusItem();
  const focusKey = useFocusStore((state) => state.focus?.key);
  const model = useMemo(
    () => (dynamics === undefined ? null : buildMechanismGraph(dynamics, execute(document, 'inspect_dynamics', {}).data)),
    [document, dynamics],
  );
  if (model === null || model.nodes.length <= 1) return null;
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  return (
    <figure className="mechanism-graph" data-testid="mechanism-graph">
      <p className="mechanism-graph__badges">
        <span className="mechanism-graph__dof" data-testid="mechanism-graph-dof">
          {model.dof === null ? 'DOF ?' : `${model.dof} DOF`}
        </span>
        {model.redundant > 0 && <span className="mechanism-graph__redundant">{model.redundant} redundant row(s)</span>}
      </p>
      <svg
        viewBox={`0 0 ${model.width} ${model.height}`}
        role="img"
        aria-label={`Mechanism: ${model.nodes.length - 1} bodies, ${model.edges.length} connections`}
      >
        {model.edges.map((edge) => (
          <Edge key={edge.id} edge={edge} nodes={byId} />
        ))}
        {model.nodes.map((node) => {
          const selected = focusKey === `mechanisms:body:${node.id}`;
          return (
            <g
              key={node.id}
              className={`mechanism-graph__node${node.fixed ? ' mechanism-graph__node--ground' : ''}${selected ? ' mechanism-graph__node--selected' : ''}`}
              role="button"
              tabIndex={node.fixed ? -1 : 0}
              aria-pressed={selected}
              aria-label={`Body ${node.label}`}
              data-testid={`mechanism-node-${node.id}`}
              onClick={() => !node.fixed && focusItem(bodyFocus(document, node.id, node.label))}
              onKeyDown={(event) => {
                if (!node.fixed && (event.key === 'Enter' || event.key === ' ')) focusItem(bodyFocus(document, node.id, node.label));
              }}
            >
              <circle cx={node.x} cy={node.y} r={NODE_RADIUS} />
              <text x={node.x} y={node.y - NODE_RADIUS - 3} textAnchor="middle" className="mechanism-graph__label">
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
      {model.problems.length > 0 && (
        <ul className="mechanism-graph__problems" data-testid="mechanism-graph-problems">
          {model.problems.map((problem) => (
            <li key={problem}>
              <span aria-hidden="true">✖</span> {problem}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
