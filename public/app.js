const formId = new URLSearchParams(location.search).get("form");
const mode = new URLSearchParams(location.search).get("mode") === "interviewer" ? "interviewer" : "self";
const state = { form: null, items: [], index: 0, answers: {}, startedAt: new Date().toISOString() };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function optionId(questionId, optionIndex) {
  return `${questionId}-${optionIndex}`;
}

function renderIntro() {
  $("#form-title").textContent = state.form.title;
  $("#intro").innerHTML = `<h1>پیش از شروع</h1>${state.form.intro.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<button class="primary-button intro-button" type="button" id="start-button">شروع پرسشنامه</button>`;
  $("#intro").hidden = false;
  $("#question-wrap").hidden = true;
  $("#actions").hidden = true;
  $("#actions").style.display = "none";
  $(".back-link").hidden = true;
  $("#step-label").hidden = true;
  $("#progress-track").hidden = true;
  $("#step-label").textContent = "";
  $("#progress-bar").style.width = "0%";
  $("#start-button").addEventListener("click", () => {
    $("#intro").hidden = true;
    $("#question-wrap").hidden = false;
    $("#actions").hidden = false;
    $("#actions").style.display = "flex";
    $(".back-link").hidden = false;
    $("#step-label").hidden = false;
    $("#progress-track").hidden = false;
    render();
  }, { once: true });
}

function currentQuestion() {
  return state.items[state.index];
}

function readAnswer(question) {
  if (question.type === "text") return $(`#answer-${question.id}`)?.value.trim() || "";
  if (question.type === "single") return document.querySelector(`input[name="${question.id}"]:checked`)?.value || "";
  return [...document.querySelectorAll(`input[name="${question.id}"]:checked`)].map((input) => input.value);
}

function writeAnswer(question, value) {
  if (question.type === "text") {
    const field = $(`#answer-${question.id}`);
    if (field) field.value = value || "";
    return;
  }
  const selected = new Set(Array.isArray(value) ? value : [value]);
  document.querySelectorAll(`input[name="${question.id}"]`).forEach((input) => {
    input.checked = selected.has(input.value);
  });
  const otherField = question.otherId && $(`#answer-${question.otherId}`);
  if (otherField && state.answers[question.otherId]) otherField.value = state.answers[question.otherId];
}

function renderAnswer(question) {
  if (question.type === "text") {
    return `<label class="sr-only" for="answer-${question.id}">${escapeHtml(question.label)}</label><textarea id="answer-${question.id}" rows="5"></textarea>`;
  }
  const inputType = question.type === "multi" ? "checkbox" : "radio";
  const options = question.options.map((option, index) => `
    <label class="choice" for="${optionId(question.id, index)}">
      <input id="${optionId(question.id, index)}" type="${inputType}" name="${question.id}" value="${escapeHtml(option)}">
      <span>${escapeHtml(option)}</span>
    </label>`).join("");
  const otherBox = question.other ? `<div class="other-box"><label for="answer-${question.otherId}">توضیح تکمیلی</label><textarea id="answer-${question.otherId}" rows="3" placeholder="در صورت تمایل توضیح دهید"></textarea></div>` : "";
  return `<div class="choices">${options}</div>${otherBox}`;
}

function render() {
  const question = currentQuestion();
  $("#question-title").textContent = question.label;
  $("#question-hint").textContent = question.hint || "";
  $("#question-hint").className = question.type === "multi" ? "question-hint multi-hint" : "question-hint";
  $("#question-hint").hidden = !question.hint;
  $("#answer-area").innerHTML = renderAnswer(question);
  writeAnswer(question, state.answers[question.id]);
  if (question.otherId && state.answers[question.otherId]) $(`#answer-${question.otherId}`).value = state.answers[question.otherId];
  $("#step-label").textContent = `سؤال ${state.index + 1} از ${state.items.length}`;
  $("#progress-bar").style.width = `${((state.index + 1) / state.items.length) * 100}%`;
  $("#prev").disabled = state.index === 0;
  $("#next").textContent = state.index === state.items.length - 1 ? "ارسال پاسخ‌ها" : "سؤال بعدی";
  $("#question-title").focus();
}

function saveCurrent() {
  const question = currentQuestion();
  const value = readAnswer(question);
  if (question.type !== "text" && (!value || (Array.isArray(value) && value.length === 0))) {
    $("#validation").textContent = "لطفاً یک پاسخ انتخاب کنید.";
    $("#validation").hidden = false;
    return false;
  }
  state.answers[question.id] = value;
  if (question.otherId) state.answers[question.otherId] = $(`#answer-${question.otherId}`)?.value.trim() || "";
  $("#validation").hidden = true;
  return true;
}

async function submit() {
  $("#next").disabled = true;
  $("#prev").disabled = true;
  $("#next").textContent = "در حال ثبت…";
  try {
    const response = await fetch("/api/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionnaire: formId, completionMode: mode, answers: state.answers }),
    });
    if (!response.ok) throw new Error("submit_failed");
    $("#question-wrap").hidden = true;
    $("#actions").hidden = true;
    $("#success").hidden = false;
  } catch {
    $("#validation").textContent = "ثبت پاسخ انجام نشد. لطفاً دوباره تلاش کنید.";
    $("#validation").hidden = false;
    $("#next").disabled = false;
    $("#prev").disabled = false;
    $("#next").textContent = "ارسال پاسخ‌ها";
  }
}

$("#next").addEventListener("click", async () => {
  if (!saveCurrent()) return;
  if (state.index === state.items.length - 1) return submit();
  state.index += 1;
  render();
});

$("#prev").addEventListener("click", () => {
  if (state.index === 0) return;
  saveCurrent();
  state.index -= 1;
  render();
});

fetch(`/api/questionnaires`)
  .then((response) => response.json())
  .then((forms) => {
    const form = forms.find((item) => item.id === formId);
    if (!form) throw new Error("form_not_found");
    return fetch(`/api/form/${formId}`).then((response) => response.json());
  })
  .then((form) => {
    state.form = form;
    state.items = [...(form.demographics || []), ...form.questions];
    document.title = form.title;
    renderIntro();
  })
  .catch(() => {
    $("#question-title").textContent = "پرسشنامه پیدا نشد.";
    $("#actions").hidden = true;
  });
