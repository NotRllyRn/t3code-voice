import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { beforeEach, expect, it } from "vite-plus/test";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("project-a"));
const draftId = DraftId.make("draft-a");
const threadId = ThreadId.make("thread-a");
const draftByKey = (key: string) => useComposerDraftStore.getState().draftsByThreadKey[key];
const draftFor = (id: ThreadId, environmentId: EnvironmentId) =>
  draftByKey(scopedThreadKey(scopeThreadRef(environmentId, id)));

beforeEach(() => {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    promotedDraftRedirects: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
});

it.each(["reserved", "assigned"] as const)(
  "moves composer edits during %s thread promotion to the canonical thread",
  (assignment) => {
    const store = useComposerDraftStore.getState();
    const promotedId = assignment === "reserved" ? threadId : ThreadId.make("live-assigned-thread");
    const promotedRef = scopeThreadRef(TEST_ENVIRONMENT_ID, promotedId);
    const foreignRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, promotedId);
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.markDraftThreadPromoting(draftId, promotedRef);
    store.setPrompt(draftId, "typed during setup");
    expect(store.getDraftIdByRef(promotedRef)).toBe(draftId);
    expect(store.getDraftSessionByRef(promotedRef)?.threadId).toBe(threadId);
    expect(store.getComposerDraft(promotedRef)?.prompt).toBe("typed during setup");
    expect(store.getDraftIdByRef(foreignRef)).toBeNull();
    expect(store.getDraftSessionByRef(foreignRef)).toBeNull();
    expect(store.getComposerDraft(foreignRef)).toBeNull();
    store.setPrompt(promotedRef, "edited in server route");
    expect(store.getComposerDraft(draftId)?.prompt).toBe("edited in server route");

    finalizePromotedDraftThreadByRef(promotedRef);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(store.getDraftIdByRef(promotedRef)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
    expect(draftFor(promotedId, TEST_ENVIRONMENT_ID)?.prompt).toBe("edited in server route");
  },
);
