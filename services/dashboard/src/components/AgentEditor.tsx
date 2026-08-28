/**
 * AgentEditor — a thin wrapper over `YamlEditor` (design-dashboard.md Requirement 82).
 *
 * It supplies exactly three things: the starting document, the validate endpoint, and the
 * save endpoint. Every editing behaviour — debounce, atomic panel replacement, two
 * severities, suggestion chips, phantom lines — lives in `YamlEditor` and is therefore
 * identical here and in `TeamEditor`.
 *
 * TWO DIVERGENCES FROM THE SPEC, BOTH BECAUSE THE CODE SAYS OTHERWISE:
 *   - The spec's data flow calls `POST /api/agents/{agent_id}/validate`. The daemon
 *     implements `POST /api/agents/validate` — collection-scoped, no id.
 *   - The spec's data flow calls `PUT /api/agents/{agent_id}` to save. The daemon
 *     implements `POST /api/agents`, an upsert keyed on the definition's `name`; PUT on an
 *     agent id returns 405. The id in the URL is therefore never sent, and renaming an
 *     agent in the editor creates a NEW agent rather than renaming the existing one.
 *
 * CLONE IS AN EDITOR PRE-FILL, NOT A SERVER ACTION (Requirement 131b). `/agents/new?from=
 * {agent_id}&version={n}` opens pre-filled with that version's definition and `name` set
 * to `{name}-copy`, suffixed `-2`, `-3` when taken. NO REQUEST IS ISSUED and nothing is
 * persisted until the operator saves; closing the editor discards the clone entirely.
 */

import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { YamlEditor } from './YamlEditor';
import { LoadError } from './EmptyState';
import { fetchAgentVersion, fetchAgents, saveAgent, validateAgent } from '../lib/api';
import { useResource } from '../lib/useResource';
import { jsonToYaml } from '../lib/yaml-anchor';

/** The skeleton a brand-new agent starts from — every key Agent Definition R11 requires. */
const BLANK_AGENT = [
  'schema_version: 1',
  'name: new-agent',
  'display_name: New agent',
  'description: ""',
  'persona:',
  '  system_prompt: |',
  '    You are a helpful assistant.',
  'model:',
  '  base_model_id: qwen3-0.6b',
  'corpus: null',
  'tools:',
  '  builtin:',
  '    - read_file',
  'sandbox:',
  '  profile: standard',
  '',
].join('\n');

/**
 * Requirement 131b / edge case 38b — `{name}-copy`, then `-copy-2`, `-copy-3`, and so on
 * when that name already exists. Exported so the naming rule is testable: it is a rule
 * with an off-by-one, and "the second clone is named -copy-2, not -copy-1" is not
 * something a screenshot shows.
 */
export function cloneName(original: string, taken: readonly string[]): string {
  const base = `${original}-copy`;
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function AgentEditor() {
  const { agentId } = useParams<{ agentId: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const cloneFrom = search.get('from');
  const cloneVersion = search.get('version');
  // The id whose definition seeds the editor: the agent being edited, or the agent being
  // cloned from. `/agents/new` with no `from` seeds from the blank skeleton.
  const seedId = agentId ?? cloneFrom ?? undefined;

  const record = useResource(
    () =>
      seedId === undefined
        ? Promise.resolve(undefined)
        : fetchAgentVersion(seedId, cloneVersion ? Number(cloneVersion) : undefined),
    [seedId, cloneVersion],
  );

  // Only needed to make the clone suffix correct. A clone still issues no MUTATING
  // request — reading the list to avoid proposing a name that already exists is not
  // persistence.
  const agents = useResource(fetchAgents, []);

  if (record.error) {
    return <LoadError what="the agent definition" error={record.error} onRetry={record.reload} />;
  }
  if (record.loading || agents.loading) {
    return <p className="text-body" style={{ padding: 'var(--space-6)' }}>Loading…</p>;
  }

  let source = BLANK_AGENT;
  if (record.data) {
    const definition = { ...record.data.definition };
    if (cloneFrom) {
      definition.name = cloneName(
        String(definition.name ?? record.data.name),
        (agents.data ?? []).map((agent) => agent.name),
      );
    }
    source = jsonToYaml(definition);
  }

  const title = agentId ? `Edit ${record.data?.name ?? agentId}` : cloneFrom ? 'Clone agent' : 'New agent';

  return (
    <YamlEditor
      title={title}
      initialSource={source}
      validate={async (definition) => validateAgent(definition)}
      save={async (definition) => {
        // POST, not PUT, and the id is not in the URL — the upsert is keyed on `name`.
        await saveAgent(definition);
        navigate('/agents');
      }}
      onCancel={() => navigate('/agents')}
    />
  );
}
