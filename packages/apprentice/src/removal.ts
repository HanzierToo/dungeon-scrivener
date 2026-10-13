import { worldSemanticDiagnostics, type WorldDocument } from '@dungeon-scrivener/model';

/** Validate the entire proposed removal before publishing any part of it. Existing
 * unrelated diagnostics do not prevent an author repairing an invalid project. */
export function removalProblem(before: WorldDocument, after: WorldDocument): string | undefined {
  const previous = new Set(worldSemanticDiagnostics(before, 'world.json').filter(item => item.severity === 'error').map(item => `${item.code}:${item.message}`));
  const diagnostics = worldSemanticDiagnostics(after, 'world.json');
  const added = diagnostics.filter(item => item.severity === 'error' && !previous.has(`${item.code}:${item.message}`)
    && !(item.code === 'DS-MOD-029' && item.message === "Conversation entry line '' does not exist." && after.conversations.some(conversation => conversation.id === item.entityId && conversation.lines.length === 0)));
  return added.length ? `Nothing was removed. Repair these references first:\n${added.map(item => item.message).join('\n')}` : undefined;
}

export function publishRemoval(before: WorldDocument, after: WorldDocument, publish: (world: WorldDocument) => void): void {
  const problem = removalProblem(before, after);
  if (problem) { window.alert(problem); return; }
  publish(after);
}
