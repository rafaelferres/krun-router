import { partitionCompatible } from "./capabilities.mjs";
import { applyPolicy } from "./policy.mjs";
import { createSessionStore } from "./sessions.mjs";
import { debug } from "./log.mjs";

/**
 * The provider-neutral router. It knows nothing about Claude Code, Codex or any wire format:
 * adapters translate their requests into the shapes below and apply the result themselves.
 *
 *   const router = createRouter({ krun });
 *   const decision = await router.route({ prompt, currentModel, availableModels, context, requirements });
 *
 * `resolveTurn` adds conversation semantics on top: route once per fresh turn, pin the
 * result for the rest of the turn, and let an explicit human model choice pass through.
 */
export function createRouter({ krun, allowlist = [], mode = "balanced", sessions = createSessionStore(), onDecision = () => {}, onManual = () => {} }) {
  async function route({ prompt, currentModel, availableModels = [], context = {}, requirements = {} }) {
    const offered = allowlist.length ? availableModels.filter((m) => allowlist.includes(m.id)) : availableModels;
    const { compatible, rejected } = partitionCompatible(offered, requirements);
    const base = {
      at: Date.now(),
      prompt,
      currentModel,
      candidates: compatible.map((m) => m.id),
      rejected,
      requirements,
      context,
      krun: null,
    };

    // With fewer than two compatible models there is nothing to decide.
    if (compatible.length === 1) return { ...base, model: compatible[0].id, reason: "only one compatible model", fallback: false };
    if (!compatible.length) {
      return { ...base, ...applyPolicy({ answer: null, error: "no compatible candidates", candidates: compatible, rejected, currentModel }) };
    }

    // Conversation facts (eval variant kinds+signals) measured neutral, so Krun gets the prompt only.
    const exchange = await krun.decide(prompt);
    const policy = applyPolicy({ answer: exchange.answer, error: exchange.error, candidates: compatible, rejected, currentModel, mode, context });
    return {
      ...base,
      ...policy,
      mode,
      kind: exchange.answer?.kind ?? null,
      confidence: exchange.answer?.confidence ?? null,
      probabilities: exchange.answer?.probabilities ?? null,
      escalate: exchange.answer?.escalate ?? null,
      abstain: exchange.answer?.abstain ?? null,
      krun: {
        request: exchange.request,
        response: exchange.response ?? null,
        requestId: exchange.requestId ?? null,
        latencyMs: exchange.latencyMs,
        error: exchange.error ?? null,
      },
    };
  }

  /**
   * turn: {
   *   conversationKey, auto, requestedModel, prompt (null unless a fresh human turn),
   *   turnId, skipRouting, baselineModel, availableModels, requirements, context
   * }
   * @returns {Promise<{ model: string, decision: object|null }>}
   */
  async function resolveTurn(turn) {
    if (!turn.auto) {
      if (turn.prompt && !turn.skipRouting) onManual({ at: Date.now(), model: turn.requestedModel, conversation: turn.conversationKey });
      return { model: turn.requestedModel, decision: null };
    }
    const state = sessions.get(turn.conversationKey);
    const fresh = turn.prompt && !turn.skipRouting;

    // A client retry of the same opening request must not route (or pay latency) twice.
    if (fresh && state.inflight?.turnId === turn.turnId) return { model: await state.inflight.promise, decision: null };
    if (!fresh || state.turnId === turn.turnId) return { model: state.model ?? turn.baselineModel, decision: null };

    let decisionOut = null;
    const promise = (async () => {
      const currentModel = state.model ?? turn.baselineModel;
      try {
        const decision = await route({
          prompt: turn.prompt,
          currentModel,
          availableModels: turn.availableModels,
          context: turn.context,
          requirements: turn.requirements,
        });
        decision.conversation = turn.conversationKey;
        decisionOut = decision;
        return decision.model ?? currentModel;
      } catch (err) {
        debug(`routing error, keeping ${currentModel}: ${err?.message}`);
        return currentModel;
      }
    })();
    state.inflight = { turnId: turn.turnId, promise };
    const model = await promise;
    state.model = model;
    state.turnId = turn.turnId;
    state.inflight = null;
    if (decisionOut) {
      debug(
        `[${turn.conversationKey}] ${decisionOut.currentModel} -> ${model} (${decisionOut.reason}` +
          `${decisionOut.krun ? `, ${decisionOut.krun.latencyMs}ms` : ""}) ctx~${turn.context?.tokens ?? "?"}`,
      );
      onDecision(decisionOut);
    }
    return { model, decision: decisionOut };
  }

  return { route, resolveTurn };
}
