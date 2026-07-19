import { api } from "./api.js";
import { el, clear, toast } from "./util.js";

export function renderConversationPane(pane, ctx) {
  clear(pane);

  const log = el("div", { class: "conversation-log" });
  pane.appendChild(log);
  ctx.conversationLog = log;

  const chapterOptions = ctx.manifest.chapters.filter((c) => !c.derived).map((c) => el("option", { value: c.file, text: c.title }));
  const scopeSelect = el("select", {}, chapterOptions);
  const generalCheckbox = el("input", { type: "checkbox", checked: true });
  const scopeLabel = el("label", { class: "check general-check" }, [generalCheckbox, "General comment (not about a specific chapter)"]);

  function syncScopeDisabled() {
    scopeSelect.disabled = generalCheckbox.checked;
  }
  generalCheckbox.addEventListener("change", syncScopeDisabled);
  syncScopeDisabled();

  const textarea = el("textarea", { placeholder: "Instruction, e.g. “Draft the document”, “Generate outline”…" });
  const sendBtn = el("button", { class: "primary send-btn", text: "➤", title: "Send" });
  const interviewBtn = el("button", {
    text: "Interview me",
    title: "Walk through the doc-type's clarification questions one at a time",
    onclick: () => runInstruction(ctx, "Interview me", "document"),
  });

  const box = el("div", { class: "instruct-box" }, [
    el("div", { class: "scope-row" }, [scopeLabel, scopeSelect]),
    el("div", { class: "compose-row" }, [textarea, sendBtn]),
    el("div", { class: "send-row" }, [interviewBtn]),
  ]);
  pane.appendChild(box);

  async function send() {
    const instruction = textarea.value.trim();
    if (!instruction) return;
    textarea.value = "";
    const scope = generalCheckbox.checked ? "document" : scopeSelect.value;
    await runInstruction(ctx, instruction, scope);
  }

  sendBtn.addEventListener("click", send);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  ctx.setScope = (file) => {
    if (file && file !== "document") {
      generalCheckbox.checked = false;
      scopeSelect.value = file;
    } else {
      generalCheckbox.checked = true;
    }
    syncScopeDisabled();
  };
  ctx.focusInstructBox = () => textarea.focus();
}

function addLogEntry(ctx, cls, text) {
  if (!ctx.conversationLog) return;
  const bubble =
    cls === "log"
      ? el("div", { class: `msg ${cls}`, text })
      : el("div", { class: `msg ${cls}` }, [
          el("span", { class: "msg-avatar", text: cls === "user" ? "🧑" : "🤖" }),
          el("div", { class: "msg-bubble", text }),
        ]);
  ctx.conversationLog.appendChild(bubble);
  ctx.conversationLog.scrollTop = ctx.conversationLog.scrollHeight;
  return bubble;
}

function addTypingIndicator(ctx) {
  if (!ctx.conversationLog) return null;
  const bubble = el("div", { class: "msg engine typing-indicator" }, [
    el("span", { class: "msg-avatar", text: "🤖" }),
    el("div", { class: "msg-bubble" }, [el("span", { class: "ai-dots" }, [el("span", {}), el("span", {}), el("span", {})])]),
  ]);
  ctx.conversationLog.appendChild(bubble);
  ctx.conversationLog.scrollTop = ctx.conversationLog.scrollHeight;
  return bubble;
}

export async function runInstruction(ctx, instruction, scope) {
  addLogEntry(ctx, "user", instruction);
  const typingBubble = addTypingIndicator(ctx);
  let typingCleared = false;
  const clearTyping = () => {
    if (!typingCleared && typingBubble) {
      typingCleared = true;
      typingBubble.remove();
    }
  };

  const checked = Array.from(ctx.checkedSourceIds || []);
  try {
    await api.instruct(ctx.slug, { instruction, scope, checked_source_ids: checked }, (event) => {
      clearTyping();
      handleEvent(ctx, event, instruction, scope);
    });
  } catch (e) {
    clearTyping();
    toast(e.message, true);
    addLogEntry(ctx, "log", "Error: " + e.message);
  }
}

function handleEvent(ctx, event, instruction, scope) {
  const handlers = ctx.chapterHandlers;
  switch (event.type) {
    case "chapter_delta": {
      const h = handlers.get(event.chapter);
      if (h) h.onDelta(event.text_chunk);
      break;
    }
    case "chapter_complete": {
      const h = handlers.get(event.chapter);
      if (h) h.onComplete(event.full_markdown);
      break;
    }
    case "manifest_update": {
      const h = event.chapter && handlers.get(event.chapter);
      if (h && event.status) h.setStatus(event.status);
      break;
    }
    case "clarification":
      renderClarificationCard(ctx, event, instruction, scope);
      break;
    case "log":
      addLogEntry(ctx, "log", event.message);
      break;
    case "done":
      ctx.refreshManifest();
      break;
  }
}

function renderClarificationCard(ctx, clarification, originalInstruction, scope) {
  const card = el("div", { class: "clarify-card" });
  card.appendChild(el("div", { class: "reason", text: clarification.reason || "Clarification needed" }));
  card.appendChild(el("div", { class: "question", text: clarification.question }));

  let selectedChoice = null;
  const freeText = el("input", { type: "text", placeholder: "Free-text answer…" });

  if (clarification.choices && clarification.choices.length) {
    const choicesRow = el("div", { class: "choices" });
    for (const choice of clarification.choices) {
      const chip = el("span", { class: "chip", text: choice });
      chip.addEventListener("click", () => {
        selectedChoice = choice;
        freeText.value = choice;
        card.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
      });
      choicesRow.appendChild(chip);
    }
    card.appendChild(choicesRow);
  }

  card.appendChild(el("div", { class: "free-text" }, [freeText]));

  const answerBtn = el("button", {
    class: "primary small",
    text: "Answer",
    onclick: async () => {
      const answer = freeText.value.trim();
      if (!answer) {
        toast("Enter or pick an answer first", true);
        return;
      }
      await submitClarification(ctx, clarification, answer, false, originalInstruction, scope);
      card.remove();
    },
  });
  const deferBtn = el("button", {
    class: "small",
    text: "Defer",
    onclick: async () => {
      await submitClarification(ctx, clarification, null, true, originalInstruction, scope);
      card.remove();
    },
  });

  card.appendChild(el("div", { class: "buttons" }, [deferBtn, answerBtn]));
  ctx.conversationLog.appendChild(card);
  ctx.conversationLog.scrollTop = ctx.conversationLog.scrollHeight;
}

async function submitClarification(ctx, clarification, answer, defer, originalInstruction, scope) {
  try {
    await api.clarify(ctx.slug, {
      question_id: clarification.question_id,
      question: clarification.question,
      chapter: clarification.blocking_chapter,
      reason: clarification.reason,
      answer,
      defer,
    });
    addLogEntry(ctx, "log", defer ? "Deferred — marked as an open question." : `Answered: ${answer}`);
    await ctx.refreshManifest();
    // Resume the paused instruction so drafting continues past this chapter.
    await runInstruction(ctx, originalInstruction, scope);
  } catch (e) {
    toast(e.message, true);
  }
}
