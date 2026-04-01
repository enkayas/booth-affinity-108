function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    const callback = (e && e.parameter && e.parameter.callback) || '';

    let result;

    if (!action) {
      result = { ok: true, message: 'Booth Affinity API is live' };
    } else if (action === 'login') {
      result = handleLogin_({
        phone: e.parameter.phone || '',
        password: e.parameter.password || ''
      });
    } else if (action === 'getBoothData') {
      result = handleGetBoothData_({
        booth: e.parameter.booth || ''
      });
    } else if (action === 'saveAffinity') {
      result = handleSaveAffinity_({
        booth: e.parameter.booth || '',
        slNo: e.parameter.slNo || '',
        affinity: e.parameter.affinity || ''
      });
    } else if (action === 'setupSystem') {
      result = setupBoothAffinitySystem_();
    } else {
      result = { ok: false, message: 'Unknown action' };
    }

    const output = callback
      ? `${callback}(${JSON.stringify(result)})`
      : JSON.stringify(result);

    return ContentService
      .createTextOutput(output)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } catch (err) {
    const result = {
      ok: false,
      message: err.message || String(err),
      stack: err.stack || ''
    };
    const callback = (e && e.parameter && e.parameter.callback) || '';
    const output = callback
      ? `${callback}(${JSON.stringify(result)})`
      : JSON.stringify(result);

    return ContentService
      .createTextOutput(output)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
}
