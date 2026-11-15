/**
 * Client half of the fresh-session bundle.
 *
 * The stock Web client reuses the first reusable blank Session for New Session.
 * That reuse keeps the blank's recorded Agent preset and its recorded
 * `subagent/model-selection-policy`, so a Session created before a DSH/plugin
 * upgrade or before an allowlist edit keeps the old composition and the old
 * model authorization.
 *
 * This patch replaces reuse with a genuine creation:
 * - `uiWorkspace.createNamed` is the single choke point every blank reuse goes
 *   through. A request that names a `sessionId` is re-minted without it, so the
 *   Host composes the current preset definition and records the current
 *   allowlist. A preset the caller asked for *now* is kept; a preset recorded in
 *   the blank's log is never inherited.
 * - `uiWorkspace.restoreBlank` (page load restoring a saved blank) mints a clean
 *   Session instead of resuming the blank, again ignoring the recorded preset.
 * - The unsent draft is copied from the replaced Session's localStorage key
 *   (`dsh.conversation.<id>`) when it carries text; empty composer state is not
 *   carried.
 * - The replaced blank is archived after navigation settles, so it leaves the
 *   reusable pool (there is no Session-delete API).
 *
 * Both wrappers are installed on the service instance and removed by the owning
 * fiber's effect on unload, so disabling the plugin restores stock behavior.
 */
window.__ModuleLoader__.load({
  id: 'dsh-fresh-session',
  factory() {
    const DRAFT_PREFIX = 'dsh.conversation.'
    const ARCHIVE_DELAY_MS = 1500

    /**
     * Diagnostics: post interception results for the Host route to read.
     * Off in the shipped build; set it to true together with the Host row's
     * `diagnostics` when re-running the verification.
     */
    const DIAGNOSTICS = false

    /**
     * Publish one interception report.
     * @param kind - report kind.
     * @param payload - JSON-serializable payload.
     */
    function report(kind, payload) {
      if (!DIAGNOSTICS) return
      try {
        void fetch('/__fresh-session/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, at: Date.now(), payload }),
        }).catch(() => {})
      } catch (_error) {
        // Diagnostics never affect navigation.
      }
    }

    /**
     * Read the persisted composer text of one Session.
     * @param sessionId - Session whose draft is read.
     * @returns the draft text, or undefined when absent or unreadable.
     */
    function draftTextOf(sessionId) {
      try {
        const raw = localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`)
        if (raw === null) return undefined
        const parsed = JSON.parse(raw)
        const draft = parsed?.draft
        if (typeof draft === 'string') return draft
        if (draft !== null && typeof draft === 'object' && typeof draft.text === 'string') return draft.text
        return undefined
      } catch (_error) {
        return undefined
      }
    }

    /**
     * Copy a non-empty draft onto the freshly created Session.
     * @param oldId - replaced Session.
     * @param newId - Session that receives the draft.
     */
    function migrateDraft(oldId, newId) {
      const text = draftTextOf(oldId)
      if (text === undefined || text.trim() === '') return
      try {
        const raw = localStorage.getItem(`${DRAFT_PREFIX}${oldId}`)
        if (raw === null) return
        localStorage.setItem(`${DRAFT_PREFIX}${newId}`, raw)
        report('draft-migrated', { oldId, newId, bytes: raw.length })
      } catch (error) {
        report('draft-failed', { oldId, error: String(error) })
      }
    }

    /**
     * Archive a replaced blank once navigation has settled.
     * @param ui - the Workspace UI service.
     * @param oldId - replaced Session.
     * @param newId - Session now selected.
     * @param timers - pending timer registry owned by the plugin fiber.
     */
    function scheduleArchive(ui, oldId, newId, timers) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        try {
          // Archiving the session the view still shows would clear that view.
          if (ui.mainReference?.sessionId === oldId) {
            report('archive-skipped', { oldId, reason: 'still-selected' })
            return
          }
          void ui.archiveSession(oldId)
            .then(() => { report('archived', { oldId, newId }) })
            .catch((error) => { report('archive-failed', { oldId, error: String(error) }) })
        } catch (error) {
          report('archive-failed', { oldId, error: String(error) })
        }
      }, ARCHIVE_DELAY_MS)
      timers.add(timer)
    }

    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        const ui = ctx.get('uiWorkspace')
        const sessions = ctx.get('sessions')
        if (ui === undefined
          || typeof ui.createNamed !== 'function'
          || typeof ui.restoreBlank !== 'function') {
          report('inactive', { reason: 'uiWorkspace navigation API unavailable' })
          return
        }

        const originalCreateNamed = ui.createNamed
        const originalRestoreBlank = ui.restoreBlank
        const timers = new Set()

        /**
         * Create a clean Session in `workspaceId` and carry the draft over.
         * @param self - receiver for the stock create call.
         * @param workspaceId - target Workspace.
         * @param preset - preset the caller asked for now, or undefined for the configured default.
         * @param oldId - Session being replaced.
         * @param label - diagnostics label.
         * @returns the new Session id.
         */
        async function mint(self, workspaceId, preset, oldId, label) {
          const request = { workspaceId }
          if (preset !== undefined) request.agentPreset = preset
          const newId = await originalCreateNamed.call(self, request)
          migrateDraft(oldId, newId)
          report(label, {
            oldId,
            newId,
            preset: preset ?? null,
            oldRecordedPreset: sessions?.list.getSnapshot().byId?.[oldId]?.projectionValues?.agentPreset ?? null,
          })
          scheduleArchive(ui, oldId, newId, timers)
          return newId
        }

        const createNamedWrapper = async function createNamedFresh(request) {
          if (request === undefined || request.sessionId === undefined) {
            return originalCreateNamed.call(this, request)
          }
          const oldId = request.sessionId
          const preset = typeof request.agentPreset === 'string' && request.agentPreset.length > 0
            ? request.agentPreset
            : undefined
          try {
            return await mint(this, request.workspaceId, preset, oldId, 'replaced')
          } catch (error) {
            report('mint-failed', { oldId, error: String(error) })
            return originalCreateNamed.call(this, request)
          }
        }

        const restoreBlankWrapper = async function restoreBlankFresh(workspaceId, sessionId) {
          try {
            return await mint(this, workspaceId, undefined, sessionId, 'restored')
          } catch (error) {
            report('restore-mint-failed', { sessionId, error: String(error) })
            return originalRestoreBlank.call(this, workspaceId, sessionId)
          }
        }

        ui.createNamed = createNamedWrapper
        ui.restoreBlank = restoreBlankWrapper
        ctx.effect(() => () => {
          for (const timer of timers) clearTimeout(timer)
          timers.clear()
          try {
            if (Object.getOwnPropertyDescriptor(ui, 'createNamed')?.value === createNamedWrapper) delete ui.createNamed
            if (Object.getOwnPropertyDescriptor(ui, 'restoreBlank')?.value === restoreBlankWrapper) delete ui.restoreBlank
          } catch (_error) {
            // A restart also clears the wrappers.
          }
        }, 'fresh-session: navigation replacements')

        report('active', { archiveDelayMs: ARCHIVE_DELAY_MS })
      },
    }
  },
})
