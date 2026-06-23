/**
 * Stable position keys for protocol import history / APR (shared by dashboard + tests).
 */

function protocolSectionKeyPrefix(p, section) {
  const sectionType = section?.type || 'Yield';
  let sectionIndex = Number.isInteger(section?.sectionIndex) ? section.sectionIndex : -1;
  if (sectionIndex < 0 && section && Array.isArray(p?.sections)) {
    sectionIndex = p.sections.indexOf(section);
  }
  if (sectionIndex >= 0) {
    let count = 0;
    for (let i = 0; i <= sectionIndex; i++) {
      if (((p.sections[i]?.type) || 'Yield') === sectionType) count++;
    }
    return `${p.name}|||${sectionType}${count > 1 ? `[${count}]` : ''}`;
  }
  let count = 0;
  for (const sec of p?.sections || []) {
    if ((sec.type || 'Yield') === sectionType) count++;
    if (sec === section) break;
  }
  return `${p.name}|||${sectionType}${count > 1 ? `[${count}]` : ''}`;
}

function protocolPositionKey(p, section, pos) {
  const prefix = protocolSectionKeyPrefix(p, section);
  return `${prefix}:${pos.sub ? `${pos.sub}:` : ''}${pos.pool}`;
}

const defiProtocolKeysExports = {
  protocolSectionKeyPrefix,
  protocolPositionKey,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = defiProtocolKeysExports;
}
if (typeof window !== 'undefined') {
  window.DefiProtocolKeys = defiProtocolKeysExports;
}
