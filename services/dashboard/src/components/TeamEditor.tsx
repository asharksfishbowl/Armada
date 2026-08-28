/**
 * TeamEditor — the second thin wrapper over `YamlEditor` (Requirement 82).
 *
 * Requirement 82's claim is that teams need no save-only fallback because
 * `POST /api/teams/validate` exists and mirrors the agent endpoint, including full-error
 * responses and no persistence on failure (Team Orchestration R39). That is confirmed in
 * the daemon: the team validate route returns `{valid, warnings, resolved_roster}` on 200
 * and `{error, errors:[{path,message}]}` on 400 — the same error shape the agent endpoint
 * returns. So teams get identical debounced live validation, atomic full-set replacement,
 * two severities, and suggestion chips, and this file supplies only the three endpoints.
 *
 * ONE DIVERGENCE WORTH KNOWING: the daemon DOES accept `PUT /api/teams/{team_id}`, unlike
 * agents — but its handler ignores the id entirely and upserts by `body.name`, so a PUT to
 * team A carrying team B's name edits team B. `POST /api/teams` is used here instead: it
 * is the same upsert without the misleading URL.
 */

import { useNavigate, useParams } from 'react-router-dom';

import { YamlEditor } from './YamlEditor';
import { LoadError } from './EmptyState';
import { fetchTeamVersion, saveTeam, validateTeam } from '../lib/api';
import { useResource } from '../lib/useResource';
import { jsonToYaml } from '../lib/yaml-anchor';

/**
 * Requirement 97 — the Teams primary action is ENABLED on a fresh installation, because
 * both shipped agents declare `capabilities` and a valid team is therefore constructible
 * from the moment the platform boots. This skeleton is what makes that true: it names the
 * two agents Agent Definition R36 seeds.
 */
const BLANK_TEAM = [
  'schema_version: 1',
  'name: new-team',
  'display_name: New team',
  'manager:',
  '  agent_name: docs-helper',
  'workers:',
  '  - agent_name: recipe-helper',
  '    alias: recipes',
  'limits:',
  '  max_delegations: 8',
  '  max_concurrent_delegations: 2',
  '',
].join('\n');

export function TeamEditor() {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();

  const record = useResource(
    () => (teamId === undefined ? Promise.resolve(undefined) : fetchTeamVersion(teamId)),
    [teamId],
  );

  if (record.error) {
    return <LoadError what="the team definition" error={record.error} onRetry={record.reload} />;
  }
  if (record.loading) {
    return <p className="text-body" style={{ padding: 'var(--space-6)' }}>Loading…</p>;
  }

  const source = record.data ? jsonToYaml(record.data.definition) : BLANK_TEAM;

  return (
    <YamlEditor
      title={teamId ? `Edit ${record.data?.name ?? teamId}` : 'New team'}
      initialSource={source}
      validate={async (definition) => validateTeam(definition)}
      save={async (definition) => {
        await saveTeam(definition);
        navigate('/teams');
      }}
      onCancel={() => navigate('/teams')}
    />
  );
}
