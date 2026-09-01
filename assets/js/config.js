// Same Apps Script backend as inventory.tlmbg.co. Calls the GET actions
// (accounts / skus / locations / commodities) to populate dropdowns, plus
// the BOL Maker Log actions (bolLog / bolLogGet / saveBolLog) for the
// "Previously Generated" history. Never writes to the Inventory Ledger or
// moves stock.
window.BOL_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby3CA2Ezbg_z6Bimw4-lRDd_r9K5muhDJNQBXMjHGqpGLPBt7rDNF6n99w_BkmMHivGUg/exec'
};
