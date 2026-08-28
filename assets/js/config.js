// Same read-only Apps Script backend as inventory.tlmbg.co — this tool only
// ever calls the GET actions (accounts / skus / locations / commodities) to
// populate dropdowns. It never writes to the ledger.
window.BOL_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby3CA2Ezbg_z6Bimw4-lRDd_r9K5muhDJNQBXMjHGqpGLPBt7rDNF6n99w_BkmMHivGUg/exec'
};
