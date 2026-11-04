/** Cache maintenance is separate from local simulation records and URL state. */
export function bindCacheControls({api,button,status,reload}) {
  let busy=false;
  const clear=async()=>{
    if(busy)return;
    busy=true;button.disabled=true;button.textContent='正在清除…';
    status.setAttribute('role','status');
    status.textContent='正在清除历史数据缓存，模拟记录会保留。';
    try{
      const result=await api.clearDataCache();
      status.textContent=result.persistentCacheAvailable===false?'已清除内存数据，当前浏览器未提供可用的持久缓存。':'历史数据缓存已清除，模拟记录已保留。';
      // Reloading the current address preserves its shareable page and filters.
      reload();
    }catch{
      status.setAttribute('role','alert');
      status.textContent='未能清除数据缓存，请重试。模拟记录未受影响。';
      button.textContent='重试清除数据缓存';
    }finally{busy=false;button.disabled=false;}
  };
  button.addEventListener('click',clear);
  return ()=>button.removeEventListener('click',clear);
}
