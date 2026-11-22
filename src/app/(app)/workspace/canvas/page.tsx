import { Workspace } from "@/components/workspace/workspace";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { requireWorkspaceUser } from "@/features/workspace/identity";
import { isWorkspaceMode, type WorkspaceMode } from "@/features/workspace/modes";
import { DEFAULT_SETTINGS } from "@/features/workspace/settings";
import { getSettings, getWorkspace } from "@/features/workspace/store";
import { templateById, templateModel } from "@/features/workspace/templates";

export default async function WorkspaceCanvasPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; id?: string; template?: string }>;
}) {
  const [user, params, authUser] = await Promise.all([
    requireWorkspaceUser(),
    searchParams,
    getAuthenticatedUser(),
  ]);

  const settings = authUser ? await getSettings(authUser.id) : DEFAULT_SETTINGS;

  let mode: WorkspaceMode = isWorkspaceMode(params.mode) ? params.mode : settings.defaultMode;
  const loaded = params.id && authUser ? await getWorkspace(authUser.id, params.id) : null;
  if (loaded) mode = loaded.summary.mode;

  // A brand-new workspace opened from a template starts with that model on the
  // canvas; the first autosave persists it like any other turn.
  const template = !loaded && params.template ? templateById(params.template) : undefined;

  return (
    <Workspace
      initialMode={mode}
      user={user}
      settings={settings}
      {...(loaded
        ? {
            workspaceId: loaded.summary.id,
            initialModel: loaded.model,
            initialTranscript: loaded.transcript,
            initialCloud: loaded.summary.cloud,
            initialTool: loaded.summary.tool,
          }
        : {})}
      {...(template ? { initialModel: templateModel(template) } : {})}
    />
  );
}
