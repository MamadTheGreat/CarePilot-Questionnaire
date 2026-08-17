const SPREADSHEET_ID = "1Go-pDNj7gZBGjFiSxIGE0nbnDruPNvrstmOin2YrCto";
const SHEET_NAME = "responses";

function doGet() {
  return jsonOutput({ ok: true, service: "carepilot-questionnaire-storage" });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");
    if (!payload.responseId || !payload.questionnaire) {
      return jsonOutput({ ok: false, error: "invalid_payload" });
    }

    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = getOrCreateSheet(spreadsheet);
    ensureHeader(sheet);
    sheet.appendRow([
      payload.responseId,
      payload.receivedAt || new Date().toISOString(),
      payload.questionnaire,
      payload.completionMode || "self",
      JSON.stringify(payload.answers || {}),
    ]);

    return jsonOutput({ ok: true, responseId: payload.responseId });
  } catch (error) {
    return jsonOutput({ ok: false, error: String(error) });
  }
}

function getOrCreateSheet(spreadsheet) {
  return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
}

function ensureHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "response_id",
      "received_at",
      "questionnaire",
      "completion_mode",
      "answers_json",
    ]);
  }
}

function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

