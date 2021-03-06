'use strict';

const Reporting = require('./reporting');

function main() {
  Reporting.reportHit('privacy.js');
  Reporting.GAService.getConfig().addCallback(config => {
    const checkbox = $('#enable-reporting')[0];
    checkbox.checked = config.isTrackingPermitted();
    checkbox.onchange = () => {
      config.setTrackingPermitted(checkbox.checked);
    };
  });
}

$(main);
