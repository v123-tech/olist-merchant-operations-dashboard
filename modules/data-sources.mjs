/** Only these already-public, immutable bytes may use the optional mirror. */
const PRODUCTION_BASE='https://v123-tech.github.io/olist-merchant-operations-dashboard/';
const MIRROR_BASE='https://cdn.jsdelivr.net/gh/v123-tech/olist-merchant-operations-dashboard@a61b43b4345774e1386f708e069c8a8e557ce272/data/';
const PINNED={
  'orders.json.gz':{bytes:9499095,sha256:'c30b3052e6cfec1479b3b378983c0fa1460f399ded4ac86076ce6073921bdebe'},
  'items.json.gz':{bytes:5677733,sha256:'e0dbd432f638c9b0ac30c31b55cff7ea835db3d66112923e0ba4a332db1b7db7'}
};
export function trustedMirrorUrl(base,name,entry,enabled=true){
  const pinned=Object.hasOwn(PINNED,name)?PINNED[name]:null;
  if(enabled===false||new URL(base).href!==PRODUCTION_BASE||!pinned||entry?.encoding!=='gzip'||entry.bytes!==pinned.bytes||entry.sha256!==pinned.sha256)return null;
  return new URL(name,MIRROR_BASE);
}
