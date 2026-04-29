/**
 * Replace {{snake_case}} placeholders in template with values from vars object.
 */
function renderSmsTemplate(template, vars) {
  const t = String(template || '');
  const map = vars && typeof vars === 'object' ? vars : {};
  return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const k = String(key).trim().toLowerCase().replace(/\s+/g, '_');
    const v = map[k];
    return v != null && v !== '' ? String(v) : `{{${key.trim()}}}`;
  });
}

module.exports = { renderSmsTemplate };
