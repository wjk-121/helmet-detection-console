/* ============================================================
 * app.js — 主应用逻辑（已对接 Flask 后端真实 API）
 * ============================================================ */

var API = window.API_BASE || '';
var state = {
  currentUser: null,
  models: [],
  selectedImageFile: null,
  selectedImageName: '',
  selectedVideoFile: null,
  batchImageFiles: [],
  batchVideoFiles: [],
  batchItems: [],
  batchIdx: 0,
  batchAborted: false,
  defaultConf: 0.5,   // 置信度默认值，由后端 /api/detect/config 拉取（config.DEFAULT_CONF）
};

// ---------- 检测页阈值（与 backend/config.py 保持一致，单位：MB / 秒） ----------
var IMG_MAX_MB = 50;
var VIDEO_MAX_MB = 1024;            // 单个视频上限 1GB
var VIDEO_MAX_SECONDS = 600;        // 视频时长上限 10 分钟
var MAX_BATCH_IMAGE_FILES = 200;
var MAX_BATCH_IMAGE_TOTAL_MB = 10240;
var MAX_BATCH_VIDEO_FILES = 30;
var MAX_BATCH_VIDEO_TOTAL_MB = 30720;

// 所有置信度输入框的 id（检测页 6 种模式各一个）
var CONF_INPUT_IDS = [
  'image-conf-value', 'batch-image-conf-value',
  'video-conf-value', 'bv-conf-value',
  'webcam-conf-value', 'stream-conf-value'
];

// 读取后端默认置信度并预填所有输入框；失败则保留前端兜底值 0.5
// 注意：仅在整页加载时调用一次（见底部启动块），不挂在 go('detect') 上，
// 这样用户在检测页内手填的置信度在「离开再回来」时会被保留，只有整页刷新才会重置。
function applyDetectConfDefaults(){
  fetch(API + '/api/detect/config', {credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d && d.ok && typeof d.default_conf === 'number'){
        state.defaultConf = d.default_conf;
      }
      // 整页加载时统一按后端默认值回填（保证 config.py 改了默认值后前端显示也随之变化）
      CONF_INPUT_IDS.forEach(function(id){
        var el = document.getElementById(id);
        if(el) el.value = state.defaultConf;
      });
    })
    .catch(function(){ /* 后端不可达时保持前端兜底 0.5 */ });
}

// 读取单个置信度输入框；非法（非 0.05~0.95、空）时回落到 state.defaultConf
function readConfValue(inputId){
  var el = document.getElementById(inputId);
  if(!el || el.value === '') return state.defaultConf;
  var v = parseFloat(el.value);
  if(isNaN(v) || v < 0.05 || v > 0.95) return state.defaultConf;
  return v;
}

// 实时校验单个置信度输入框（失焦时调用）：
// 越界或非法时纠正回默认值并提示；合法时规整为两位小数。
function validateConfField(el){
  if(!el) return;
  var raw = el.value;
  var v = parseFloat(raw);
  if(raw === '' || isNaN(v) || v < 0.05 || v > 0.95){
    el.value = state.defaultConf;
    toast('置信度需在 0.05～0.95 之间，已重置为 ' + state.defaultConf);
    return;
  }
  el.value = v.toFixed(2);
}

// 实时校验抽帧间隔输入框（失焦时调用）：须为 1~10 的整数，非法则纠正回默认 2 并提示。
// 开关关闭时输入框为 disabled，不会触发 blur，无需额外判断。
function validateSkipField(el){
  if(!el) return;
  var raw = el.value;
  var v = parseInt(raw, 10);
  if(raw === '' || isNaN(v) || v < 1 || v > 10 || String(parseFloat(raw)) !== String(v)){
    el.value = 2;
    toast('抽帧间隔需为 1～10 的整数，已重置为 2');
    return;
  }
  el.value = v;
}

// 网络流运行时实时修改置信度：流已连接时，把当前「置信度」框值推给后端，
// 后端 gen() 每帧读取最新值 → 下一帧即用新阈值，无需重连。
// 未连接时无需推送（startStream 会把当前框值拼进连接 URL 作为初始值）。
function updateStreamConf(){
  if(!state.streamActive || !state.streamSid) return;
  var el = document.getElementById('stream-conf-value');
  var v = el ? parseFloat(el.value) : state.defaultConf;
  if(isNaN(v)) v = state.defaultConf;
  fetch(API + '/api/detect/stream/conf?sid=' + encodeURIComponent(state.streamSid)
        + '&conf=' + v, {method:'POST', credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(d){ /* 静默：失败不影响，下次连接仍会用框值 */ })
    .catch(function(){});
}

// 当前批量任务的 AbortController（P1-3：批量可中止）；非批量时为 null
var _batchAbort = null;
// 当前批量任务的收尾函数（P1-3/P2-3：取消或完成时调用，存于闭包外以便取消逻辑触发）
var _batchFinish = null;

// 视频预检：读取文件元数据，返回 Promise<{ok, reason, duration}>
//   - 大小超过 VIDEO_MAX_MB → 拒绝（避免无效上传）
//   - 时长超过 VIDEO_MAX_SECONDS → 拒绝
//   - 读不出元数据（损坏/特殊编码）→ 放行，交由服务端校验
function precheckVideoFile(f){
  return new Promise(function(resolve){
    if(f.size > VIDEO_MAX_MB * 1024 * 1024){
      resolve({ok:false, reason:'文件过大（>' + VIDEO_MAX_MB + ' MB / 1GB）'});
      return;
    }
    var url = URL.createObjectURL(f);
    var v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = function(){
      URL.revokeObjectURL(url);
      var dur = v.duration || 0;
      if(dur > VIDEO_MAX_SECONDS){
        resolve({ok:false, reason:'时长过长（' + Math.round(dur) + ' 秒 > ' + VIDEO_MAX_SECONDS + ' 秒 / 10 分钟）'});
      } else {
        resolve({ok:true, duration:dur});
      }
    };
    v.onerror = function(){
      URL.revokeObjectURL(url);
      resolve({ok:true, duration:0});   // 元数据读不出，放行，服务端兜底
    };
    v.src = url;
  });
}

// ==================== 全局推理任务控制 ====================
// 四种检测模式（单图 / 单视频 / 批量图 / 批量视频）共用一套控制器，遮罩底部出现两个按钮：
//   · 「后台推理」= 只收起遮罩，**连接保持不中断**，任务继续跑完并正常落库，完成后弹通知。
//   · 「终止推理」= abort 当前请求；后端感知连接断开后会立刻停手并清理已上传文件（不落库）。
// ⚠ 两者区别：后台推理**不能**断开连接——一断后端就当中止处理了（这是上一轮刚定下的语义）。
var _taskAbort = null;      // 当前任务的 AbortController（四种模式共用）
var _taskFinish = null;     // 当前任务的收尾函数（可选）
var _taskLabel = '推理任务';
state.taskAborted = false;

function startTask(label, finish){
  if(_taskAbort){ toast('已有推理任务在进行中，新任务会排队等待'); }
  state.taskAborted = false;
  _taskLabel = label || '推理任务';
  _taskFinish = finish || null;
  _taskAbort = new AbortController();
  _batchAbort = _taskAbort;           // 批量代码沿用旧变量名，指向同一个 controller
  showCancelBtn(true, abortTask);   // 批量会在之后覆盖成 cancelCurrentBatch
  return _taskAbort;
}

function endTask(){
  _taskAbort = null;
  _taskFinish = null;
  state.taskAborted = false;
  showCancelBtn(false);
  var badge = document.getElementById('bg-task-badge');
  if(badge) badge.style.display = 'none';
}

// 后台推理：收起遮罩，任务继续跑（连接保持），右下角留一个角标，完成后自动消失
function runInBackground(){
  if(!_taskAbort) return;      // 没有进行中的任务时不动遮罩（按钮此时也是隐藏的）
  hideLoading();
  var badge = document.getElementById('bg-task-badge');
  var txt = document.getElementById('bg-task-text');
  if(txt) txt.textContent = '后台推理中：' + _taskLabel;
  if(badge) badge.style.display = 'flex';
  toast('已转入后台推理，完成后会通知你（刷新或关闭页面会终止本次推理）');
}

// 终止推理：abort + 收尾；后端会在感知断开后立刻停手并清理，不落库
function abortTask(){
  if(!_taskAbort) return;
  state.taskAborted = true;
  try { _taskAbort.abort(); } catch(e){}
  var f = _taskFinish;
  _taskFinish = null;
  if(f){ try { f(); } catch(e){} }
  hideLoading();
  endTask();
  toast('已终止推理（后端已停止并清理，不会留下记录）');
}

// 加载遮罩内的任务按钮显隐：显示时「后台推理」+「终止推理」成对出现
function showCancelBtn(on, onCancel){
  var wrap = document.getElementById('loading-actions');
  var b = document.getElementById('loading-cancel');
  var bg = document.getElementById('loading-bg');
  if(!b) return;
  if(on){
    b.style.display = 'inline-block';
    b.onclick = onCancel || abortTask;
    if(bg) bg.style.display = 'inline-block';
    if(wrap) wrap.style.display = 'flex';
  } else {
    b.style.display = 'none';
    b.onclick = null;
    if(bg) bg.style.display = 'none';
    if(wrap) wrap.style.display = 'none';
  }
}

// 取消当前批量任务（P1-3）：标记已取消 → 中止进行中的 fetch → 触发收尾
function cancelCurrentBatch(){
  if(state.batchAborted || !_batchAbort) return;
  state.batchAborted = true;
  _batchAbort.abort();
  if(_batchFinish) _batchFinish();
  endTask();
}

// 批量结果汇总弹窗（P2-3）：成功/失败数、耗时、跳转历史
function openBatchSummary(o){
  var el = document.getElementById('batch-summary');
  if(!el) return;
  document.getElementById('bs-title').textContent =
    (o.kind === 'video' ? '批量视频检测完成' : '批量图片检测完成');
  document.getElementById('bs-body').innerHTML =
    '共 <b>'+o.total+'</b> 个，成功 <b style="color:#5aa96c">'+o.ok+'</b>'+
    (o.fail ? ('，失败 <b style="color:#e57373">'+o.fail+'</b>') : '')+
    '，耗时 <b>'+o.secs+'</b> 秒。';
  openModal('batch-summary');
}

// ---------- fetch 辅助 ----------
function api(path, opts){
  opts = opts || {};
  opts.credentials = 'same-origin';
  opts.headers = opts.headers || {};
  if(opts.body && !(opts.body instanceof FormData)){
    opts.headers['Content-Type'] = 'application/json';
  }
  return fetch(API + path, opts).then(function(r){
    return r.json().then(function(d){
      if(r.status === 401 && path !== '/api/login' && state.currentUser){
        var reason = (d && d.reason) || '';
        state.currentUser = null;
        var msg = (d && d.msg) || '登录已失效，请重新登录';
        // 改密码(kicked)用橙色警示，其余(过期/满30天/拉黑/删除)用红色
        toast(msg, reason === 'kicked' ? 'warning' : 'error');
        setTimeout(function(){ go('login'); }, 1200);
      }
      return {status:r.status, data:d};
    });
  });
}

// ===== 注入侧边栏和顶部栏 =====
function injectChromes(){
  var sideTpl=document.getElementById('tpl-sidebar');
  var topTpl=document.getElementById('tpl-topbar');
  document.querySelectorAll('[data-sidebar]').forEach(function(el){
    el.appendChild(sideTpl.content.cloneNode(true));
  });
  document.querySelectorAll('[data-topbar]').forEach(function(el){
    var node=topTpl.content.cloneNode(true);
    var title=el.getAttribute('data-title');
    if(title){
      var t=node.querySelector('[data-top-title]');
      if(t) t.textContent=title;
    }
    el.appendChild(node);
  });
  // 初始状态与 URL hash 对齐：hash=#industrial 时拓展菜单直接展开。
  // 否则首屏先渲染成收起态、等 /api/me 回来再由 go() 展开 → 菜单列表跳一下
  syncNavGroupOpen((location.hash || '').replace('#',''));
}
injectChromes();

// 拓展菜单分组开合与当前视图联动（工控页展开，其余收起）
function syncNavGroupOpen(view){
  var shouldOpen = (view === 'industrial');
  document.querySelectorAll('.nav-group').forEach(function(g){
    g.classList.toggle('open', shouldOpen);
  });
}

function updateChromeUser(){
  if(!state.currentUser) return;
  var name = state.currentUser.username;
  document.querySelectorAll('.user-name').forEach(function(e){ e.textContent = name; });
  document.querySelectorAll('.role-tag').forEach(function(e){
    e.textContent = state.currentUser.role === 'admin' ? '管理员' : '普通用户';
  });
  document.querySelectorAll('.avatar').forEach(function(e){ e.textContent = (name||'A').charAt(0).toUpperCase(); });
  var meta = state.currentUser.created_at
    ? '创建时间：' + (state.currentUser.created_at || '').slice(0, 10)
    : '';
  document.querySelectorAll('.user-meta').forEach(function(e){ e.textContent = meta; });
  // 按角色隐藏管理菜单
  var isAdmin = state.currentUser.role === 'admin';
  document.querySelectorAll('.nav-item[data-role="admin"]').forEach(function(el){
    el.style.display = isAdmin ? '' : 'none';
  });
  // 其他按角色显示的元素（如分拣统计的「只看我的 / 全部」切换）
  document.querySelectorAll('.role-admin').forEach(function(el){
    el.style.display = isAdmin ? '' : 'none';
  });
  // 工作台标题按角色
  document.querySelectorAll('#view-dash h2').forEach(function(el){
    el.textContent = isAdmin ? '管理员工作台' : '我的工作台';
  });
  // 常用入口最后一个卡片：管理员=模型管理，普通用户=个人中心
  var qm = document.getElementById('quick-models');
  if(qm){
    if(isAdmin){
      qm.setAttribute('onclick', "go('models')");
      qm.querySelector('h4').textContent = '模型管理';
      qm.querySelector('p').textContent = '切换、上传与维护 YOLO 模型';
    } else {
      qm.setAttribute('onclick', "go('profile')");
      qm.querySelector('h4').textContent = '个人中心';
      qm.querySelector('p').textContent = '查看账号信息与修改密码';
    }
  }
}

// ===== 路由 =====
var PROTECTED = ['dash','detect','industrial','models','train','history','articles','users','articles-admin','profile'];
function toggleNavGroup(e){
  var btn = e.currentTarget || e.target;
  var group = btn.closest('.nav-group');
  if(group){
    group.classList.toggle('open');
  }
}

function go(view){
  // 未登录访问受保护页面，跳登录
  if(PROTECTED.indexOf(view) >= 0 && !state.currentUser){
    view = 'login';
  }
  // 普通用户访问管理页，跳工作台
  var ADMIN_VIEWS = ['models','train','users','articles-admin'];
  if(state.currentUser && state.currentUser.role !== 'admin' && ADMIN_VIEWS.indexOf(view) >= 0){
    view = 'dash';
    toast('该页面仅管理员可用');
  }
  // industrial 模块权限由数据库控制：普通用户需被授权才能访问
  if(view === 'industrial' && state.currentUser && state.currentUser.role !== 'admin'){
    var checkExt = function(){
      api('/api/ext/modules').then(function(res){
        var visible = res.data.ok && res.data.modules && res.data.modules['industrial'];
        if(!visible){
          toast('您没有该模块的访问权限');
          go('dash');
        }
      });
    };
    if(!state._extMods) checkExt();
    else if(!state._extMods['industrial']){ checkExt(); }
  }
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active')});
  var el=document.getElementById('view-'+view);
  if(el) el.classList.add('active');
  // 刷新恢复：首次路由（页面加载/刷新）时原地恢复到该视图上次的滚动停留位；
  // 应用内跳转（点导航/切视图）照旧回顶部
  if(_initialRouting){ restoreScrollPos(view); }   // 刷新：原地恢复到位
  else { window.scrollTo(0,0); }                   // 应用内跳转：回顶部
  closeSidebar();
  document.querySelectorAll('.nav-item').forEach(function(n){
    n.classList.toggle('active', n.getAttribute('data-view')===view);
  });
  // 拓展菜单展开状态统一：进入工控页自动展开，其他页面自动收起
  syncNavGroupOpen(view);
  if(location.hash!=='#'+view){ history.replaceState(null,'','#'+view); }
  if(view==='register') loadCaptcha('register');
  if(view==='profile'){ loadCaptcha('name'); loadCaptcha('pw'); }
  if(view==='feedback') loadFeedback();
  if(view==='extensions') loadExtModules();
  // 离开智能检测页：释放摄像头与网络流
  if(view!=='detect'){
    if(state.webcamStream) stopWebcam();
    if(state.streamActive) stopStream();
  }
  // 离开工业控制页：释放摄像头、停止所有轮询定时器、释放页面锁
  if(view!=='industrial'){
    if(typeof _ind !== 'undefined' && _ind.webcamStream) indStopCamera(true);
    if(typeof indStopAllTimers === 'function') indStopAllTimers();
    if(typeof indReleasePageLock === 'function') indReleasePageLock();
  }
  if(view==='detect' && state.currentUser){ checkDetectLock(); }
  loadCurrentView();
}

// ===== 拓展模块海报墙 =====
function loadExtModules(){
  api('/api/ext/modules').then(function(res){
    if(!res.data.ok) return;
    var mods = res.data.modules || {};
    var modsKey = Object.keys(mods).sort().join(',');
    var grid = document.getElementById('ext-poster-grid');
    var isAdmin = state.currentUser && state.currentUser.role === 'admin';
    document.getElementById('ext-perm-btn').style.display = isAdmin ? '' : 'none';
    state._extUsers = res.data.users || [];
    state._extGrants = res.data.grants || {};
    state._extMods = mods;
    // 只有模块列表变化时才重新渲染（避免闪烁）
    if(state._extModsKey === modsKey) return;
    state._extModsKey = modsKey;
    var cards = '';
    Object.keys(mods).forEach(function(key){
      var m = mods[key];
      cards += '<div class="ext-poster-card ext-clickable" onclick="go(\''+key+'\')" style="--card-accent:#d4a05c;--card-glow:rgba(212,160,92,0.25);">' +
        '<div class="ext-poster-bg"></div>' +
        '<div class="ext-poster-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></div>' +
        '<div class="ext-poster-tag">已上线</div>' +
        '<div class="ext-poster-info">' +
        '<div class="ext-poster-title">'+m.name+'</div>' +
        '<div class="ext-poster-desc">'+m.desc+'</div>' +
        '<div class="ext-poster-enter">进入模块 →</div>' +
        '</div></div>';
    });
    cards += '<div class="ext-poster-card ext-placeholder">' +
      '<div class="ext-poster-bg"></div>' +
      '<div class="ext-poster-icon" style="opacity:0.4;"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg></div>' +
      '<div class="ext-poster-tag" style="background:rgba(255,255,255,0.1);color:var(--text-3);">开发中</div>' +
      '<div class="ext-poster-info">' +
      '<div class="ext-poster-title" style="color:var(--text-3);">更多功能</div>' +
      '<div class="ext-poster-desc" style="color:var(--text-3);">敬请期待，新模块持续开发中...</div>' +
      '<div class="ext-poster-enter" style="color:var(--text-3);opacity:0.5;">即将上线</div>' +
      '</div></div>';
    grid.innerHTML = cards;
  });
}
function openExtPermModal(){
  var users = state._extUsers || [];
  var grants = state._extGrants || {};
  var mods = state._extMods || {};
  var html = '<div style="font-size:13px;color:var(--text-3);margin-bottom:12px;">选择模块后，勾选可访问的用户。管理员默认全部可见。</div>';
  Object.keys(mods).forEach(function(mod){
    html += '<div style="margin-bottom:16px;padding:12px;background:var(--card);border-radius:10px;">' +
      '<div style="font-weight:600;margin-bottom:8px;color:var(--text-1);">'+mods[mod].name+'</div>';
    if(users.length){
      users.forEach(function(u){
        var checked = (grants[mod]||[]).indexOf(u.id) >= 0 ? 'checked' : '';
        html += '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;color:var(--text-2);cursor:pointer;">' +
          '<input type="checkbox" class="ext-perm-cb" data-module="'+mod+'" value="'+u.id+'" '+checked+' style="width:15px;height:15px;">' +
          u.username + (u.user_code?'（'+u.user_code+'）':'') + (u.phone?' · '+u.phone:'') +
          '</label>';
      });
    } else {
      html += '<div style="font-size:13px;color:var(--text-3);padding:4px 0;">暂无普通用户</div>';
    }
    html += '</div>';
  });
  document.getElementById('ext-perm-content').innerHTML = html;
  openModal('ext-perm-modal');
}
function saveExtPerm(){
  var byModule = {};
  Object.keys(state._extMods||{}).forEach(function(mod){ byModule[mod] = []; });
  document.querySelectorAll('.ext-perm-cb:checked').forEach(function(cb){
    var mod = cb.getAttribute('data-module');
    if(!byModule[mod]) byModule[mod] = [];
    byModule[mod].push(parseInt(cb.value));
  });
  var modules = Object.keys(byModule);
  var done = 0;
  modules.forEach(function(mod){
    api('/api/ext/access', {method:'POST', body: JSON.stringify({module:mod, user_ids:byModule[mod]})})
      .then(function(res){
        done++;
        if(done === modules.length){
          toast('权限设置已保存', 'success');
          closeModal('ext-perm-modal');
          loadExtModules();
        }
      });
  });
}

// ===== 视图数据加载器统一注册表 =====
// 规则：每个受保护视图只需在这里注册一个 loader 函数，
// go() 首次进入和全局 5s 轮询都会自动调用，无需在多处单独维护。
var VIEW_LOADERS = {
  'dash':           loadDashStats,
  'detect':         loadCurrentModelBar,
  'history':        loadHistory,
  'models':         loadModels,
  'train':          loadTrain,
  'users':          loadUsers,
  'articles':       loadPubArticles,
  'articles-admin': loadArticles,
  'profile':        loadProfile,
  'feedback':       loadFeedback,
  'extensions':    loadExtModules,
  'industrial':     function(){
    indCheckAndEnter();
  },
};

function loadCurrentView(){
  var v = location.hash.replace('#','') || 'home';
  var fn = VIEW_LOADERS[v];
  if(fn){ try{ fn(); }catch(e){ console.warn('loader error:', v, e); } }
}
function toggleSidebar(force){
  var open=typeof force==='boolean' ? force : true;
  document.querySelectorAll('.sidebar').forEach(function(s){ s.classList.toggle('open', open); });
  var mask=document.getElementById('sidebar-mask');
  if(mask) mask.classList.toggle('show', open);
}
function closeSidebar(){ toggleSidebar(false); }

// ===== 登录 / 注册 =====
// ==================== 图形验证码 ====================
var _captchaIds = {login: null, register: null, name: null, pw: null};
function loadCaptcha(which){
  api('/api/captcha').then(function(res){
    if(!res.data.ok) return;
    _captchaIds[which] = res.data.cid;
    document.getElementById('captcha-'+which+'-img').src = res.data.img;
  });
}
var _codeCountdown = 0;
var _codeTimer = null;
function switchLoginTab(mode){
  var pw = document.getElementById('login-pw-mode');
  var cd = document.getElementById('login-code-mode');
  var tp = document.getElementById('tab-pw-login');
  var tc = document.getElementById('tab-code-login');
  if(mode==='code'){
    pw.style.display='none'; cd.style.display='block';
    tp.style.color='var(--text-3)'; tp.style.borderBottomColor='transparent';
    tc.style.color='var(--accent)'; tc.style.borderBottomColor='var(--accent)';
  } else {
    pw.style.display='block'; cd.style.display='none';
    tp.style.color='var(--accent)'; tp.style.borderBottomColor='var(--accent)';
    tc.style.color='var(--text-3)'; tc.style.borderBottomColor='transparent';
  }
}
function sendBarkCode(){
  var phone = document.getElementById('code-phone').value.trim();
  if(!/^1\d{10}$/.test(phone)){ toast('请输入正确的 11 位手机号'); return; }
  api('/api/send-bark-code', {method:'POST', body: JSON.stringify({phone:phone})})
    .then(function(res){
      if(res.data.ok){
        toast('验证码已发送到 Bark', 'success');
        _codeCountdown = 120;
        var btn = document.getElementById('btn-send-code');
        btn.disabled = true;
        btn.style.opacity = '.6';
        btn.style.cursor = 'not-allowed';
        if(_codeTimer) clearInterval(_codeTimer);
        _codeTimer = setInterval(function(){
          _codeCountdown--;
          if(_codeCountdown <= 0){
            clearInterval(_codeTimer);
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
            btn.textContent = '发送验证码';
          } else {
            btn.textContent = _codeCountdown + ' 秒后重发';
          }
        }, 1000);
      } else {
        toast(res.data.msg || '发送失败');
      }
    }).catch(function(){ toast('网络错误'); });
}
function doLoginWithCode(){
  var phone = document.getElementById('code-phone').value.trim();
  var code = document.getElementById('bark-login-code').value.trim();
  if(!/^1\d{10}$/.test(phone)){ toast('请输入正确的 11 位手机号'); return; }
  if(!/^\d{6}$/.test(code)){ toast('请输入 6 位数字验证码'); return; }
  api('/api/login-with-code', {method:'POST', body: JSON.stringify({phone:phone, code:code})})
    .then(function(res){
      if(res.data.ok){
        state.currentUser = res.data.user;
        updateChromeUser();
        toast('登录成功，'+res.data.user.username+'！', 'success');
        go('dash');
        if(typeof resumePendingDeep === 'function') resumePendingDeep();
      } else {
        toast(res.data.msg || '登录失败');
      }
    }).catch(function(){ toast('网络错误'); });
}
function doLogin(){
  var u=document.getElementById('username').value.trim();
  var p=document.getElementById('password').value;
  if(!u||!p){ toast('请输入手机号和密码'); return; }
  if(!/^1\d{10}$/.test(u)){ toast('请输入正确的 11 位手机号'); return; }
  api('/api/login', {method:'POST', body: JSON.stringify({phone:u, password:p})})
    .then(function(res){
      if(res.data.ok){
        state.currentUser = res.data.user;
        updateChromeUser();
        toast('登录成功，'+res.data.user.username+'！', 'success');
        go('dash');
        if(typeof resumePendingDeep === 'function') resumePendingDeep();
      } else {
        toast(res.data.msg || '登录失败');
      }
    }).catch(function(){ toast('网络错误，请检查网络连接'); });
}
function doRegister(){
  var u=document.getElementById('reg-username').value.trim();
  var ph=document.getElementById('reg-phone').value.trim();
  var p=document.getElementById('reg-password').value;
  var p2=document.getElementById('reg-password2').value;
  var c=document.getElementById('captcha-register').value.trim();
  if(!ph||!p||!p2){ toast('请完整填写注册信息'); return; }
  if(!/^1\d{10}$/.test(ph)){ toast('请输入正确的 11 位手机号'); return; }
  if(p.length<6){ toast('密码至少 6 位'); return; }
  if(p!==p2){ toast('两次输入的密码不一致'); return; }
  if(!c){ toast('请输入验证码'); return; }
  api('/api/register', {method:'POST', body: JSON.stringify({username:u, phone:ph, password:p, captcha_id:_captchaIds.register, captcha_code:c})})
    .then(function(res){
      if(res.data.ok){
        state.currentUser = res.data.user;
        updateChromeUser();
        toast('欢迎加入，'+u+'！', 'success');
        go('dash');
        if(typeof resumePendingDeep === 'function') resumePendingDeep();
      } else {
        toast(res.data.msg || '注册失败');
        loadCaptcha('register');
        document.getElementById('captcha-register').value='';
      }
    }).catch(function(){ toast('网络错误，请检查网络连接'); });
}
function logout(){
  confirmDialog('退出登录','确定要退出当前账号吗？', function(){
    api('/api/logout', {method:'POST'}).finally(function(){
      state.currentUser = null;
      go('home');
      toast('已退出登录');
    });
  });
}
// ===== 图片检测 =====
function pickImage(){ document.getElementById('detect-file').click(); }
function onImagePicked(input){
  var f = input.files[0];
  if(!f) return;
  // 单张图片独立上限（与后端 P0-4 一致），前置拦截避免无效上传
  if(f.size > IMG_MAX_MB * 1024 * 1024){
    toast('图片过大，单张不能超过 '+IMG_MAX_MB+' MB');
    input.value = '';
    state.selectedImageFile = null;
    document.getElementById('image-dropzone-text').innerHTML = '拖拽图片到这里，或 <span class="hl">点击选择文件</span>';
    setImageFileHint(null);
    return;
  }
  state.selectedImageFile = f;
  state.selectedImageName = f.name;
  document.getElementById('image-dropzone-text').innerHTML =
    '已选择：<span class="hl">'+f.name+'</span>（'+(f.size/1024).toFixed(0)+' KB）';
  setImageFileHint(f);
}

// 单张图片面板的「尚未选择文件」提示区（与批量模式风格一致）
function setImageFileHint(f){
  var el = document.getElementById('image-file-hint');
  if(!el) return;
  el.innerHTML = f
    ? '<div class="file-item"><span class="fname">'+f.name+'</span><span class="fsize">'+(f.size/1024).toFixed(0)+' KB</span></div>'
    : '<div style="color:var(--text-2);font-size:13px;padding:8px 0">尚未选择文件</div>';
}
// ===== 重置结果区（开始新检测前调用，避免上次残留） =====
function resetResult(){
  state.videoResultActive = false;   // 停掉视频结果页的逐帧画框循环
  document.getElementById('detect-empty').style.display='none';
  document.getElementById('detect-result').style.display='block';
  document.getElementById('video-result').style.display='none';
  document.getElementById('batch-nav').style.display='none';
  document.getElementById('tbl-note').style.display='none';
  // 清空摘要与计数
  var h4 = document.querySelector('#detect-result .summary-card h4');
  if(h4) h4.textContent = '检测中...';
  // 清空原图/结果图
  var imgs = document.querySelectorAll('#detect-result .result-imgs img');
  imgs.forEach(function(im){ im.src = ''; });
  // 清空视频
  var v = document.getElementById('result-video');
  if(v){ v.removeAttribute('src'); v.load(); }
  // 清空明细表
  var tbody = document.querySelector('#detect-result table.data tbody');
  if(tbody) tbody.innerHTML='';
  // 新检测开始：先收起左侧模式占位图（检测完成后再点亮）
  state._dvReady = false;
  syncDetectVisual();
  vizReset();   // 图表回到空态（等本次结果）
}

function runDetect(){
  if(!state.selectedImageFile){ toast('请先选择一张图片'); return; }
  var fd = new FormData();
  fd.append('file', state.selectedImageFile);
  fd.append('conf', readConfValue('image-conf-value'));
  showLoading('正在推理，请稍候...', 60);
  setLoadProgress(0, 0, '正在推理…首次推理需加载模型，请耐心等待');   // 不确定动画：防误以为卡死
  resetResult();
  var ac = startTask('图片推理');
  fetch(API + '/api/detect/image', {method:'POST', body: fd, credentials:'same-origin',
        signal: ac.signal})
    .then(function(r){ return r.json(); })
    .then(function(d){
      endTask(); hideLoading();
      if(state.taskAborted) return;      // 已终止：abortTask 里提示过了
      if(!d.ok){ toast(d.msg || '检测失败'); return; }
      renderImageResult(d);
      vizSetData({mode:'image', boxes:d.boxes, stats:d.stats,
                  name: state.selectedImageName || '', items:null, frames:null});
      toast('检测完成，耗时 '+d.duration_ms+' ms');
    })
    .catch(function(e){
      endTask(); hideLoading();
      if(state.taskAborted) return;
      toast('检测请求失败：'+e.message);
    });
}
// 明细表上方的说明文字：四种模式统一显示（noteId 可指定目标元素，默认检测页 tbl-note，供历史详情抽屉复用）
//   frames = 图片/批量图片：逐框明细（每框一行）
//   agg    = 视频/批量视频：按类别聚合（全片统计，平均框）
function setTblNote(mode, count, noteId){
  var note = document.getElementById(noteId || 'tbl-note');
  if(!note) return;
  if(mode === 'frames'){
    note.textContent = (count || 0) > 0
      ? ('共检测到 ' + count + ' 个目标，下表为每个检测框的类别、置信度与边界框坐标（原图像素）。')
      : '本次未检测到目标。';
  }else{
    note.textContent = '全片按类别统计：置信度为该类所有框的平均值，坐标为平均框。';
  }
  note.style.display = 'block';
}

function renderStatsChips(stats, wrapId){  var sw = document.getElementById(wrapId);
  if(!sw) return;
  var chips = [];
  for(var k in stats){
    chips.push('<span style="display:inline-block;padding:4px 12px;margin:0 6px 6px 0;border-radius:14px;background:rgba(201,152,107,.12);color:var(--accent);font-size:13px">'+k+'：'+stats[k]+'</span>');
  }
  sw.innerHTML = chips.length
    ? '<div style="font-size:13px;color:var(--text-3);margin-bottom:6px">统计信息</div>'+chips.join('')
    : '';
}
// ===== 图片结果的检测框（前端 canvas 绘制） =====
// 检测页图片模式改为「彻底前端画框」：用户看到的框全部由前端 canvas 绘制（顺滑、配色统一）。
// 磁盘上不再存带框结果图：落盘只留「原图 + 框数据 JSON」，页面上的框一律前端现场绘制；
// 用户要带框图片时走 /api/record/<id>/download 由后端现场合成下载。
// ⚠ 坐标是**原图空间**（后端直接对原图推理），这里按显示宽度等比换算即可（容器与图同尺寸）。
var _imgBoxState = {img: null, boxes: null};

// 通用：在任意 2D 上下文上画框。box 坐标是目标像素空间，乘 scale 转成绘制像素；
// lw/fs 为线宽与字号（像素）；ox/oy 为 letterbox 偏移（object-fit:contain 时画面未铺满的留白）。
// 显示画布 scale=显示宽/原图宽，归档画布 scale=1 但 lw/fs 按「原图像素/显示 CSS 宽」放大，
// 保证两处框的观感一致。
function drawBoxesCore(g, boxes, scale, lw, fs, alpha, ox, oy){
  ox = ox || 0; oy = oy || 0;
  g.lineWidth = lw;
  g.font = '600 ' + fs + 'px system-ui, "Microsoft YaHei", sans-serif';
  for(var i = 0; i < boxes.length; i++){
    var b = boxes[i];
    var x1 = b.x1 * scale + ox, y1 = b.y1 * scale + oy, x2 = b.x2 * scale + ox, y2 = b.y2 * scale + oy;
    var col = _boxColor(b);
    g.globalAlpha = (alpha === undefined ? 1 : alpha);
    g.fillStyle = _boxFill(col, .16);
    g.fillRect(x1, y1, x2 - x1, y2 - y1);
    g.strokeStyle = col;
    g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    var label = b.cls_name + ' ' + Math.round((b.conf || 0) * 100) + '%';
    var tw = g.measureText(label).width;
    var ly = Math.max(0, y1 - (fs + 3));
    g.fillStyle = _boxFill(col, .92);
    g.fillRect(x1, ly, tw + 8, fs + 3);
    g.fillStyle = '#ffffff';
    g.fillText(label, x1 + 4, ly + fs - 1);
  }
  g.globalAlpha = 1;
}

function drawBoxesOnImg(imgEl, boxes, alpha){
  var cv = document.getElementById('detect-result-box-canvas');
  if(!cv || !imgEl) return;
  var nw = imgEl.naturalWidth, bw = imgEl.clientWidth, bh = imgEl.clientHeight;
  if(!nw || !bw){ return; }
  // 把框数据挂在 canvas 上（原图空间坐标），供 Lightbox 放大预览时按新尺寸重画
  cv._boxData = {boxes: boxes, iw: nw, ih: imgEl.naturalHeight};
  var sc = bw / nw;
  var dpr = window.devicePixelRatio || 1;
  var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
  if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, bw, bh);
  if(!boxes || !boxes.length) return;
  drawBoxesCore(g, boxes, sc, 2, 12, alpha);
}

// 注：旧的 archiveImageResult（前端合成整图回存归档）已删除。
// 落盘策略改为「只存原图 + 框数据 JSON」，带框图片由下载接口现场绘制。

// 框淡入（220ms），比直接"啪"地出现更精致
function drawBoxesOnImgAnimated(imgEl, boxes){
  _imgBoxState.img = imgEl; _imgBoxState.boxes = boxes;
  var start = performance.now();
  function step(){
    var t = Math.min(1, (performance.now() - start) / 220);
    drawBoxesOnImg(imgEl, boxes, t);
    if(t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// 窗口尺寸变化后按新尺寸重画（画布是像素级绘制，不会自动跟随）
window.addEventListener('resize', function(){
  if(_imgBoxState.img && _imgBoxState.boxes){ drawBoxesOnImg(_imgBoxState.img, _imgBoxState.boxes); }
  if(_vizChart){ try{ _vizChart.resize(); }catch(e){} }   // 图表随容器宽度重绘
  if(_streamChart){ try{ _streamChart.resize(); }catch(e){} }   // 网络流播放完成图表随容器宽度重绘
  if(_detailRecord){ try{ renderDetailChart(_detailRecord); }catch(e){} }   // 详情抽屉左侧图表随窗口高度自适应重排
});

// 检测结果摘要卡统一文案（四种模式同一模板，信息全量）：
//   图片类：检测到 N 个目标 · M 个类别（刀×3、枪×2…）· 耗时 X
//   视频类：共 F 帧（推理 I 帧）· 检测到 N 个目标 · M 个类别（…）· 耗时 X
//   类别数 M = stats 键数（此前四个模式都没显示）；类别太多截断防撑爆摘要卡。
function buildDetectSummary(d, isVideo){
  var stats = (d && d.stats) || {};
  var total = 0, keys = [];
  for(var k in stats){ if(stats[k] > 0){ total += stats[k]; keys.push(k); } }
  if(!total) return '未检测到目标';
  // 耗时：≥1s 显示秒（1 位小数），否则毫秒
  var ms = d.duration_ms || 0;
  var cost = ms >= 1000 ? ((ms / 1000).toFixed(1) + ' s') : (Math.round(ms) + ' ms');
  var parts = [];
  if(isVideo){
    var fr = d.total_frames || 0, inf = d.inferred_frames || 0;
    if(fr) parts.push('共 ' + fr + ' 帧' + (inf && inf < fr ? '（推理 ' + inf + ' 帧）' : ''));
  }
  parts.push('检测到 ' + total + ' 个目标');
  parts.push(keys.length + ' 个类别');
  parts.push('耗时 ' + cost);
  return parts.join(' · ');
}

function renderImageResult(d){
  document.querySelector('#detect-result .summary-card h4').textContent = buildDetectSummary(d, false);
  var imgs = document.querySelectorAll('#detect-result .result-imgs figure');
  if(imgs[0]){ var o=imgs[0].querySelector('img'); if(o) o.src = API + d.image_url; }
  if(imgs[1]){
    var r = document.getElementById('detect-result-img');
    if(r){
      // 底图就是**原图**（磁盘上不再有结果图），框全部由 canvas 叠加绘制
      r.onload = function(){ drawBoxesOnImgAnimated(r, d.boxes); };
      r.src = API + d.image_url;
      if(r.complete && r.naturalWidth){ drawBoxesOnImgAnimated(r, d.boxes); }
    }
  }
  renderDetectDownloadBtn(d && d.record_id);
  // 左侧图表数据由调用方负责（runDetect=单图 / renderBatchItem=批量）：
  // 这里是共用渲染函数，不能清批次数据，否则批量翻页会把"本批次"视图挤回"类别分布"。
  // 统计
  var total = 0;
  var statText = [];
  for(var k in d.stats){ statText.push(k+': '+d.stats[k]); total += d.stats[k]; }
  // 说明文字：图片为逐框明细（每框一行），与视频的按类别聚合文案区分
  setTblNote('frames', d.boxes ? d.boxes.length : 0);
  renderStatsChips(d.stats, 'detect-stats-wrap');
  // 明细表
  var tbody = document.querySelector('#detect-result table.data tbody');
  if(tbody){
    tbody.innerHTML='';
    (d.boxes||[]).forEach(function(b){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+b.cls_name+'</td><td>'+b.conf+'</td><td>'+
        b.x1+', '+b.y1+', '+b.x2+', '+b.y2+'</td>';
      tbody.appendChild(tr);
    });
  }
  // 结果就绪：点亮左侧模式占位图
  state._dvReady = true;
  syncDetectVisual();
}

// ===== 视频检测 =====
// ===== 视频检测结果：原始视频 + canvas 画框（前端逐帧对齐，与工控页一致）=====
// 双轨：归档仍是后端标注 mp4（result_url，兜底/下载），但展示用原始视频 + 前端框时间轴。
state.videoResultActive = false;
state.videoBoxes = null; state.videoFps = 25; state.videoW = 0; state.videoH = 0; state.videoNames = {};
function renderVideoResult(d){
  var v = document.getElementById('result-video');
  var cv = document.getElementById('video-box-canvas');
  if(!v) return;
  state.videoResultActive = true;
  state.videoBoxes = null;
  if(cv) cv.style.display = 'none';
  if(d.boxes_url && d.source_url){
    // 原始视频作为底层（原生流畅播放），框由时间轴逐帧叠加
    // 翻页竞态防护：批量结果快速切换时，旧视频的时间轴响应晚到不得覆盖新视频
    v._tlToken = (v._tlToken || 0) + 1;
    var tlTok = v._tlToken;
    v.src = API + d.source_url;
    v.load();
    v.play().catch(function(){});   // 无控件自动循环播放（muted 才允许 autoplay）
    fetch(API + d.boxes_url, {credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(tl){
        if(!state.videoResultActive || tlTok !== v._tlToken) return;
        state.videoBoxes = tl.frames || [];
        state.videoFps = tl.fps || 25;
        state.videoW = tl.width || 0;
        state.videoH = tl.height || 0;
        state.videoNames = tl.names || {};
        if(cv) cv.style.display = state.videoBoxes.length ? 'block' : 'none';
        // 帧时间轴到位：补齐图表的「帧级趋势」视图
        vizUpdateFrames();
        // 时间轴挂到 video 元素上：点击视频进 Lightbox / 全屏时照常逐帧画框
        v._boxTimeline = {boxes: state.videoBoxes, fps: state.videoFps,
                          w: state.videoW, h: state.videoH, names: state.videoNames};
        videoBoxLoop();
      })
      .catch(function(){ if(cv) cv.style.display = 'none'; });
  } else {
    // 无时间轴（旧记录/兜底）：直接播后端标注 mp4
    v.src = API + (d.result_url || d.source_url);
    v.load();
    v.play().catch(function(){});
    v._boxTimeline = null;   // 标注 mp4 自带框，无需叠加
    if(cv) cv.style.display = 'none';
  }
  renderDetectDownloadBtn(d && d.record_id);
}

// 下载「带框」结果：后端拿到原文件 + 框数据现场绘制后返回，不预生成、不占磁盘
function renderDetectDownloadBtn(recordId){
  var wrap = document.getElementById('detect-download-wrap');
  if(!wrap) return;
  if(!recordId){ wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'block';
  // 「点下载时才现场把框绘制进图片/视频」属实现说明，只留代码注释不进页面
  wrap.innerHTML = '<button class="btn btn-ghost btn-sm" onclick="downloadMarked(' + recordId + ', this)">' +
    '下载标注文件</button>';
}

// 下载「带框」文件 —— 两阶段，避免把几十 MB 文件塞进 JS 内存：
//   ① POST /api/record/<id>/prepare：后端现场合成并流式推进度（弹层显示进度）
//   ② 合成完拿到一次性 token → 交给浏览器直接下载（后端推流，文件不进内存）
// ===== 下载「带框文件」的健壮实现 =====
// 三层保护：
//   ① 前端跨标签页锁（localStorage）—— 多开几个页面也绕不过去，同一记录本机同一时刻只能下一个；
//   ② 后端按记录互斥（prepare 409）—— 真·并发兜底（即使绕过前端）；
//   ③ 轮询进度 + 看门狗：超过 45s 没有任何成功的轮询响应即判定异常，
//      主动通知后端停手并明确报错，绝不无限转圈。
// 为什么用「后台任务 + 轮询 JSON」而不是流式 NDJSON：实测部分浏览器环境会把流式响应
// 吞掉/缓冲（fetch 永远收不到第一个字节，页面卡死在"准备中"），而普通 JSON 请求全部
// 正常 —— 因此只依赖已被验证可靠的 JSON 通道（启动/轮询/取消全用 GET + JSON）。
// 另：版本自检（APP_VERSION 与 /api/version 不符则自动硬刷新），彻底杜绝“一直跑旧 JS”。
var APP_VERSION = "20261029a1";
var _dlBusy = false;        // 本页是否正在下载（即时防连点）
var _dlWatch = null;        // 超时看门狗定时器
var _dlCancelled = false;   // 是否为用户主动取消
var _dlRid = null;          // 当前正在下载的记录 id（用于跨标签页解锁）
var _dlStopPoll = null;     // 停止轮询的开关（取消/完成时置停）
var _DL_KEY = function(r){ return 'yolo_dl_busy_' + r; };

// —— 跨标签页锁：localStorage 在本机所有同源标签页间共享 ——
function _dlTabLock(rid){
  try {
    var v = localStorage.getItem(_DL_KEY(rid));
    if(v){ var ts = parseInt(v, 10); if(!isNaN(ts) && Date.now() - ts < 5*60*1000) return false; }
    localStorage.setItem(_DL_KEY(rid), String(Date.now()));
    return true;
  } catch(e){ return true; }   // 拿不到本地存储就放行，后端 409 兜底
}
function _dlTabUnlock(rid){
  try {
    var v = localStorage.getItem(_DL_KEY(rid));
    if(v){ var ts = parseInt(v, 10); if(!isNaN(ts) && Date.now() - ts < 10*60*1000) localStorage.removeItem(_DL_KEY(rid)); }
  } catch(e){}
}
// —— 发起者标记：本浏览器亲手发起过 rid 的合成，刷新后仍可重夺下载权 ——
// 与跨标签页锁相反：此标记**故意跨刷新保留**（发起人刷新后理应仍能下载），仅在
// 真正下载完成/取消时才清除（见 _dlFinish）。后端 download_marked 仍强制校验
// token 的 user_id，跨用户拿 token 照样 400，前端标记只是 UX 便利，绕不过后端。
var _DL_INIT_KEY = function(r){ return 'yolo_dl_initiator_' + r; };
function _dlInitSet(rid){ try{ localStorage.setItem(_DL_INIT_KEY(rid), '1'); }catch(e){} }
function _dlInitGet(rid){ try{ return localStorage.getItem(_DL_INIT_KEY(rid)) === '1'; }catch(e){ return false; } }
function _dlInitClear(rid){ try{ localStorage.removeItem(_DL_INIT_KEY(rid)); }catch(e){} }
// 刷新/关闭页面时主动释放本页持有的下载锁：否则 localStorage 残留会让本页卡在
// “该文件正在其他页面下载中”最多 5 分钟（直到 _dlTabLock 的 TTL 自愈才消失）。
function _dlReleaseOnUnload(){ if(_dlRid != null){ try{ _dlTabUnlock(_dlRid); }catch(e){} } }
window.addEventListener('beforeunload', _dlReleaseOnUnload);

// —— 版本自检：打开页面 / 切回前台 / 定期 复检时，发现服务端版本更新就自动硬刷新 ——
// 这是根治“浏览器一直跑旧 JS（被 12 小时缓存头锁死）”的最后一道闸。
(function _dlVersionCheck(){
  function check(){
    fetch(API + '/api/version', {credentials: 'same-origin', cache: 'no-store'})
      .then(function(r){
        if(!r.ok) return;                 // 旧后端无此接口：不刷新（刷新也救不了旧后端）
        return r.json().catch(function(){ return null; });
      })
      .then(function(d){
        if(d && d.version && d.version !== APP_VERSION){
          console.warn('[dl] 前端版本过期 (%s → %s)，自动刷新', APP_VERSION, d.version);
          location.reload(true);          // 硬刷新：连缓存一起破
        }
      }).catch(function(){});
  }
  check();
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) check(); });
  setInterval(check, 60000);              // 后端更新后，哪怕页面一直开着也能自动跟上
})();

// —— 后端心跳（反向探活）：后端挂了前端不能一直干挂着 ——
// 各业务轮询的 fetch 失败都被静默吞掉，后端一死页面毫无征兆。这里每 5s 轻量探测
// /api/version（带 3.5s 超时），连续 2 次失败判定失联：顶部常驻横幅 + 一次 toast；
// 恢复后自动撤横幅并提示。接口极轻（返回一行 JSON），对后端无压力。
var _hbFails = 0, _hbDown = false;
function _hbBanner(show){
  var b = document.getElementById('conn-banner');
  if(!b){
    b = document.createElement('div');
    b.id = 'conn-banner';
    b.className = 'conn-banner';
    b.innerHTML = '<span class="conn-dot"></span><span id="conn-banner-txt"></span>';
    document.body.appendChild(b);
  }
  b.classList.toggle('show', !!show);
  if(show){
    var tx = document.getElementById('conn-banner-txt');
    if(tx) tx.textContent = '与后端失去连接，正在自动重试…（请确认后端程序是否还在运行）';
  }
}
function _hbBeat(){
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, 3500) : null;   // 超时视为失败
  fetch(API + '/api/version', {credentials:'same-origin', cache:'no-store',
        signal: ctl ? ctl.signal : undefined})
    .then(function(r){
      if(timer) clearTimeout(timer);
      if(!r.ok) throw new Error('status ' + r.status);
      _hbFails = 0;
      if(_hbDown){ _hbDown = false; _hbBanner(false); toast('后端连接已恢复', 'success'); }
    })
    .catch(function(){
      if(timer) clearTimeout(timer);
      _hbFails++;
      if(_hbFails >= 2 && !_hbDown){
        _hbDown = true;
        _hbBanner(true);
        toast('与后端失去连接', 'error');
      }
    });
}
setInterval(_hbBeat, 5000);
_hbBeat();

// 弹层里的“取消/关闭”按钮：通知后端停手 + 收尾隐藏弹层
(function(){
  var c = document.getElementById('dl-cancel');
  if(c) c.addEventListener('click', function(){
    _dlCancelled = true;
    if(_dlRid != null){
      // 通知后端中止合成（异步发出即可，不必等结果）
      fetch(API + '/api/record/' + _dlRid + '/prepare-cancel',
            {credentials: 'same-origin', cache: 'no-store'}).catch(function(){});
    }
    if(_dlStopPoll) _dlStopPoll();
    _dlFinish(false, '已取消下载');
  });
})();

function downloadMarked(rid, btn){
  if(_dlBusy){ toast('正在合成/下载上一个文件，请稍候再点'); return; }
  // 跨标签页锁：已被本机其他页面占用 → 直接拦下（根治“多开页面绕过连点”）
  if(!_dlTabLock(rid)){
    toast('该文件正在其他页面下载中，请稍候');
    return;
  }
  _dlBusy = true;
  _dlCancelled = false;
  _dlRid = rid;

  var ov  = document.getElementById('dl-overlay');
  var bar = document.getElementById('dl-bar');
  var pct = document.getElementById('dl-pct');
  var sub = document.getElementById('dl-sub');
  var card = ov ? ov.querySelector('.dl-card') : null;
  if(card) card.className = 'dl-card';
  if(ov) ov.classList.remove('hidden');
  if(bar){ bar.classList.remove('indeterminate'); bar.style.width = '0%'; }
  if(pct) pct.textContent = '准备中…';
  if(sub) sub.textContent = '请稍候，后台正在逐帧处理…';

  var stopFlag = false;                // 本轮下载是否已结束（完成/失败/取消）
  _dlStopPoll = function(){ stopFlag = true; };
  var lastOk = Date.now();             // 最近一次收到轮询响应的时间（看门狗用）
  var isInitiator = false;             // 本设备是否为下载任务发起者（决定 done 后是真下载还是只给提示）

  // 看门狗：超过 45s 没有任何成功的轮询响应 → 判定异常：停轮询 + 通知后端停手 + 明确报错
  _dlWatch = setInterval(function(){
    if(!stopFlag && Date.now() - lastOk > 45000){
      stopFlag = true;
      fetch(API + '/api/record/' + rid + '/prepare-cancel',
            {credentials: 'same-origin', cache: 'no-store'}).catch(function(){});
      _dlFinish(false, '下载超时：后端长时间无响应，已自动取消');
    }
  }, 3000);

  function finishJob(m){               // state = done / error / cancelled
    if(stopFlag) return;
    stopFlag = true;
    if(m && m.state === 'done' && m.token){
      if(card) card.className = 'dl-card done';
      if(bar){ bar.classList.remove('indeterminate'); bar.style.width = '100%'; }
      if(pct) pct.textContent = '完成 100%';
      if(isInitiator){
        // 发起设备：真正触发浏览器下载（token 一次性，仅此处消耗）
        if(sub) sub.textContent = '正在唤起浏览器下载…';
        var a = document.createElement('a');
        a.href = API + '/api/record/' + rid + '/download?token=' + encodeURIComponent(m.token);
        a.download = m.name || '';   // 同源 + download 属性：强制附件；出错也不整页跳 JSON 黑页
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function(){ if(a.parentNode) a.parentNode.removeChild(a); }, 1500);
        toast('合成完成（' + (Math.round((m.size || 0) / 1048576 * 10) / 10) +
              ' MB），请在保存对话框中选择位置');
      } else {
        // 围观设备：只能看进度，不下载（避免“见者有份”给服务器加压）；给提示即可
        if(sub) sub.textContent = '合成完成（仅发起下载的设备可保存）';
        toast('合成完成：本设备仅可观看进度，请在发起下载的设备上保存文件');
      }
      _dlFinish(true, '');
    } else {
      _dlFinish(false, (m && m.msg) || '合成未完成，请重试');
    }
  }
  function poll(){
    if(stopFlag) return;
    fetch(API + '/api/record/' + rid + '/prepare-status',
          {credentials: 'same-origin', cache: 'no-store'})
      .then(function(r){
        if(stopFlag) return null;
        lastOk = Date.now();           // 只要有响应（哪怕 404/500）就说明通道活着
        return r.json().catch(function(){ return null; });
      })
      .then(function(m){
        if(stopFlag || !m) { if(!stopFlag) setTimeout(poll, 1200); return; }
        if(m.state === 'running'){
          if(m.total && m.total > 0){
            var p = Math.round(m.done / m.total * 100);
            if(bar){ bar.classList.remove('indeterminate'); bar.style.width = p + '%'; }
            if(pct) pct.textContent = '合成中 ' + p + '%';
          } else {
            if(bar) bar.classList.add('indeterminate');
            if(pct) pct.textContent = '正在处理…';
          }
          setTimeout(poll, 800);
        } else {
          finishJob(m);
        }
      })
      .catch(function(){
        // 单次轮询失败不致命（比如后端正好重启）；持续失败由看门狗兜底
        if(!stopFlag) setTimeout(poll, 1500);
      });
  }

  // 启动合成任务（GET，立即返回 JSON）。409 = 已有任务在跑 → 直接进入轮询接管它的进度
  fetch(API + '/api/record/' + rid + '/prepare',
        {credentials: 'same-origin', cache: 'no-store'})
    .then(function(r){ return r.json().catch(function(){ return null; }); })
    .then(function(d){
      if(stopFlag) return;
      if(!d || !d.ok){
        var busy = d && ((d.msg && d.msg.indexOf('正在合成中') >= 0) || d.state === 'running');
        if(busy){ isInitiator = _dlInitGet(rid); poll(); return; }  // 本浏览器发起过→仍是发起者（刷新可重夺）；否则旁观
        _dlFinish(false, (d && d.msg) || '启动合成失败，请重试');
        return;
      }
      isInitiator = true; _dlInitSet(rid);   // 本设备成功启动合成 = 发起者，done 时才有下载资格（标记跨刷新保留）
      poll();
    })
    .catch(function(e){
      if(!stopFlag) _dlFinish(false, '启动合成失败：' + (e && e.message ? e.message : e));
    });
}

// 收尾：清看门狗、解跨标签页锁、解本页忙、提示并关闭弹层
function _dlFinish(ok, msg){
  if(_dlWatch){ clearInterval(_dlWatch); _dlWatch = null; }
  _dlBusy = false;
  if(_dlRid != null){ _dlTabUnlock(_dlRid); _dlInitClear(_dlRid); _dlRid = null; }
  var ov = document.getElementById('dl-overlay');
  var card = ov ? ov.querySelector('.dl-card') : null;
  var sub = ov ? ov.querySelector('#dl-sub') : null;
  if(card && !ok){ card.className = 'dl-card err'; if(sub) sub.textContent = (msg || '出错了'); }
  if(msg) toast(msg);
  // 取消类反馈停留短（约1.2s，让用户看见“已取消”即可收起）；其它错误略长便于阅读；成功600ms收尾
  var hideDelay = ok ? 600 : ((msg && msg.indexOf('取消') >= 0) ? 1200 : 2200);
  if(ov) setTimeout(function(){ ov.classList.add('hidden'); }, hideDelay);
}
function videoBoxLoop(){
  if(!state.videoResultActive) return;
  var v = document.getElementById('result-video');
  var cv = document.getElementById('video-box-canvas');
  if(v && cv){
    var bw = v.clientWidth, bh = v.clientHeight;
    if(bw && bh && state.videoBoxes && state.videoBoxes.length && v.duration){
      var fw = state.videoW || v.videoWidth, fh = state.videoH || v.videoHeight;
      if(fw && fh){
        var sc = Math.min(bw / fw, bh / fh);
        var ox = (bw - fw * sc) / 2, oy = (bh - fh * sc) / 2;
        var dpr = window.devicePixelRatio || 1;
        var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
        if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
        var g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, bw, bh);
        var idx = Math.round((v.currentTime || 0) * state.videoFps);
        if(idx < 0) idx = 0;
        if(idx >= state.videoBoxes.length) idx = state.videoBoxes.length - 1;
        var arr = state.videoBoxes[idx] || [];
        if(arr.length){
          var boxes = arr.map(function(a){
            return {cls: a[0], cls_name: state.videoNames[String(a[0])] || String(a[0]),
                    conf: a[1], x1: a[2], y1: a[3], x2: a[4], y2: a[5]};
          });
          drawBoxesCore(g, boxes, sc, 2, 12, 1, ox, oy);
        }
      }
    }
  }
  requestAnimationFrame(videoBoxLoop);
}

function pickVideo(){ document.getElementById('detect-video-file').click(); }

// 读取视频面板的「抽帧开关 + 间隔 + 置信度」控件（P1-5）。
//   enabledId/valueId/confId 为对应输入控件 id（单视频与批量视频用不同前缀）。
// 返回 {ok, skip, conf} 或 {ok:false, msg}（校验未过，调用方应阻止发起）。
function readSkipConf(enabledId, valueId, confId){
  var enabledEl = document.getElementById(enabledId);
  var enabledOn = enabledEl ? enabledEl.checked : false;
  // 置信度（可选子项）：范围 0.05~0.95，默认取后端 DEFAULT_CONF
  var confEl = document.getElementById(confId);
  var conf = state.defaultConf;
  if(confEl && confEl.value !== ''){
    conf = parseFloat(confEl.value);
    if(isNaN(conf) || conf < 0.05 || conf > 0.95){
      return {ok:false, msg:'置信度需为 0.05~0.95 之间的数字'};
    }
  }
  if(!enabledOn){
    // 关闭抽帧 = 不使用抽帧 = 逐帧推理（skip=1）
    return {ok:true, skip:1, conf:conf};
  }
  // 开启：读取间隔，校验 1~10 整数
  var vEl = document.getElementById(valueId);
  var raw = vEl ? vEl.value.trim() : '';
  if(!/^\d+$/.test(raw)){
    return {ok:false, msg:'请输入 1-10 之间的整数'};
  }
  var n = parseInt(raw, 10);
  if(n < 1 || n > 10){
    return {ok:false, msg:'请输入 1-10 之间的整数'};
  }
  return {ok:true, skip:n, conf:conf};
}

// 抽帧开关联动：开启时启用「间隔」输入框，关闭时禁用（P1-5）
function videoSkipToggle(prefix){
  var cb = document.getElementById(prefix+'-skip-enabled');
  var inp = document.getElementById(prefix+'-skip-value');
  if(cb && inp) inp.disabled = !cb.checked;
}

function onVideoPicked(input){
  var f=input.files[0];
  if(!f) return;
  // P1-4：选择时预检大小 + 时长，超限不发起上传（服务端仍会兜底校验）
  precheckVideoFile(f).then(function(res){
    if(!res.ok){
      toast('视频「'+f.name+'」'+res.reason+'，已取消选择');
      input.value='';
      state.selectedVideoFile=null;
      document.getElementById('video-dropzone-text').innerHTML =
        '拖拽视频到这里，或 <span class="hl">点击选择文件</span>';
      setVideoFileHint(null);
      return;
    }
    state.selectedVideoFile=f;
    document.getElementById('video-dropzone-text').innerHTML =
      '已选择：<span class="hl">'+f.name+'</span>（'+(f.size/1024/1024).toFixed(1)+' MB）';
    setVideoFileHint(f);
  });
}

// 单个视频面板的「尚未选择视频」提示区（与批量模式风格一致）
function setVideoFileHint(f){
  var el = document.getElementById('video-file-hint');
  if(!el) return;
  el.innerHTML = f
    ? '<div class="queue-item"><span class="dot"></span><span>'+f.name+' — '+((f.size/1024/1024).toFixed(1))+' MB</span></div>'
    : '<div style="color:var(--text-2);font-size:13px;padding:8px 0">尚未选择视频</div>';
}
function runVideoDetect(){
  if(!state.selectedVideoFile){ toast('请先选择一个视频'); return; }
  // P1-5：读取抽帧/置信度（仅本次请求生效，不影响他人、不持久化）
  var sc = readSkipConf('video-skip-enabled', 'video-skip-value', 'video-conf-value');
  if(!sc.ok){ toast(sc.msg); return; }
  var fd=new FormData();
  fd.append('file', state.selectedVideoFile);
  fd.append('skip', sc.skip);
  fd.append('conf', sc.conf);
  showLoading('视频逐帧推理中，时长较长请耐心等待...', 900);
  setLoadProgress(0, 0, '准备推理…首次推理需加载模型');   // 首条帧进度到达前走不确定动画
  resetResult();
  // 流式接口：先收进度行，最后收结果行（老接口 /api/detect/video 保留为同步 JSON）
  var ac = startTask('视频推理：' + state.selectedVideoFile.name);
  fetch(API + '/api/detect/video/stream', {method:'POST', body: fd, credentials:'same-origin',
        signal: ac.signal})
    .then(function(r){
      if(!r.body){ return r.json().then(function(d){ return d.ok ? d : Promise.reject(new Error(d.msg||'失败')); }); }
      var reader=r.body.getReader(), decoder=new TextDecoder('utf-8'), buf='';
      function pump(){
        return reader.read().then(function(step){
          if(step.done){
            if(buf.trim()) handleLine(buf.trim());
            return null;
          }
          buf+=decoder.decode(step.value, {stream:true});
          var lines=buf.split('\n');
          buf=lines.pop();
          lines.forEach(handleLine);
          return pump();
        });
      }
      var finalData=null, finalErr=null;
      function handleLine(line){
        if(!line) return;
        var msg;
        try{ msg=JSON.parse(line); }catch(e){ return; }
        if(msg.type==='progress'){
          setLoadProgress(msg.done, msg.total, '已处理 '+msg.done+' 帧'+(msg.total?(' / '+msg.total+' 帧'):''));
        }else if(msg.type==='result'){ finalData=msg.data; }
        else if(msg.type==='error'){ finalErr=msg.msg; }
      }
      return pump().then(function(){
        if(finalErr) throw new Error(finalErr);
        if(!finalData) throw new Error('未收到处理结果');
        return finalData;
      });
    })
    .then(function(d){
      endTask(); hideLoading();
      if(state.taskAborted) return;      // 已终止
      if(!d.ok){ toast(d.msg || '视频检测失败'); return; }
      document.getElementById('detect-empty').style.display='none';
      document.getElementById('detect-result').style.display='block';
      document.querySelector('#detect-result .result-imgs').style.display='none';
      document.getElementById('video-result').style.display='block';
      document.querySelector('#detect-result .summary-card h4').textContent = buildDetectSummary(d, true);
      setTblNote('agg');
      renderStatsChips(d.stats, 'detect-stats-wrap');
      // 明细表：视频用代表帧（第一个检测到目标的帧）的框
      var tbody = document.querySelector('#detect-result table.data tbody');
      if(tbody){
        tbody.innerHTML='';
        (d.boxes||[]).forEach(function(b){
          var tr=document.createElement('tr');
          tr.innerHTML='<td>'+b.cls_name+'</td><td>'+b.conf+'</td><td>'+
            b.x1+', '+b.y1+', '+b.x2+', '+b.y2+'</td>';
          tbody.appendChild(tr);
        });
      }
      var v=document.getElementById('result-video');
      // 左侧图表：单视频（帧级趋势要等时间轴到位，由 vizUpdateFrames 补齐）
      vizSetData({mode:'video', boxes:d.boxes, stats:d.stats,
                  name: (state.selectedVideoFile && state.selectedVideoFile.name) || '',
                  items:null, frames:null});
      renderVideoResult(d);
      // 结果就绪：点亮左侧模式占位图
      state._dvReady = true;
      syncDetectVisual();
      toast('视频检测完成，耗时 '+Math.round(d.duration_ms/1000)+' 秒');
    })
    .catch(function(e){
      endTask(); hideLoading();
      if(state.taskAborted) return;
      toast('视频请求失败：'+e.message);
    });
}

// ===== 批量图片检测 =====
state.batchImageFiles = [];
function onBatchImagesPicked(input){
  var files = Array.from(input.files);
  if(!files.length) return;
  // P1-1/P1-2：数量 + 总大小 软限制（前端拦截，服务端仍会兜底）
  if(files.length > MAX_BATCH_IMAGE_FILES){
    toast('批量图片最多 '+MAX_BATCH_IMAGE_FILES+' 张，已选 '+files.length+' 张，请精简后重试');
    input.value='';
    return;
  }
  var totalMB = files.reduce(function(s,f){ return s + f.size; }, 0) / 1024 / 1024;
  if(totalMB > MAX_BATCH_IMAGE_TOTAL_MB){
    toast('批量图片总大小不能超过 '+MAX_BATCH_IMAGE_TOTAL_MB+' MB（'+(MAX_BATCH_IMAGE_TOTAL_MB/1024).toFixed(0)+' GB），当前约 '+totalMB.toFixed(0)+' MB');
    input.value='';
    return;
  }
  state.batchImageFiles = files;
  var list = document.getElementById('batch-image-list');
  document.getElementById('batch-image-text').innerHTML =
    '已选择 <span class="hl">'+state.batchImageFiles.length+'</span> 张图片';
  list.innerHTML = '';
  state.batchImageFiles.forEach(function(f){
    var div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = '<span class="fname">'+f.name+'</span><span class="fsize">'+(f.size/1024).toFixed(0)+' KB</span>';
    list.appendChild(div);
  });
}
function runBatchImage(){
  if(!state.batchImageFiles.length){ toast('请先选择图片'); return; }
  // 逐张调用单图接口（复用已有的 /api/detect/image），这样能实时显示"第几张 / 共几张"
  resetResult();
  var files = state.batchImageFiles;
  var total = files.length, idx = 0, okCount = 0, failCount = 0;
  var cancelled = false;   // 后端返回「已取消」= 中途断开，已被中止并清理，不算失败
  var okItems = [];
  var imgConf = readConfValue('batch-image-conf-value');
  var t0 = Date.now();
  var finished = false;
  // P1-3：本次批量任务的 AbortController，支持中途取消（同时注册进全局任务控制）
  state.batchAborted = false;
  startTask('批量图片（'+total+' 张）');
  showCancelBtn(true, cancelCurrentBatch);
  showLoading('批量推理 '+total+' 张图片，请稍候...', 600);
  setLoadProgress(0, total, '第 0 / '+total+' 张');
  function finishBatch(){
    if(finished) return;
    finished = true;
    endTask();
    showCancelBtn(false);
    _batchAbort = null;
    _batchFinish = null;
    hideLoading();
    var secs = ((Date.now()-t0)/1000).toFixed(1);
    toast('批量'+(cancelled?'已取消':'完成')+'：成功 '+okCount+' / 共 '+total+' 张'
          +(failCount?('，失败 '+failCount+' 张'):''));
    state.batchItems = okItems;
    state.batchIdx = 0;
    if(okItems.length){
      document.getElementById('detect-empty').style.display='none';
      document.getElementById('detect-result').style.display='block';
      document.querySelector('#detect-result .result-imgs').style.display='flex';
      document.getElementById('video-result').style.display='none';
      document.getElementById('batch-nav').style.display = okItems.length>1 ? 'flex':'none';
      renderBatchItem();
      // 结果就绪：点亮左侧模式占位图
      state._dvReady = true;
      syncDetectVisual();
    }
    // P2-3：弹出汇总（成功/失败/耗时 + 跳转历史）
    openBatchSummary({kind:'image', total:total, ok:okCount, fail:failCount, secs:secs});
  }
  _batchFinish = finishBatch;
  function nextOne(){
    if(state.batchAborted){ finishBatch(); return; }   // P1-3：已被取消
    if(idx >= total){ finishBatch(); return; }
    var f = files[idx];
    showLoading('正在处理第 '+(idx+1)+' / '+total+' 张：'+f.name, 600);
    setLoadProgress(idx, total, '第 '+(idx+1)+' / '+total+' 张');
    var fd = new FormData();
    fd.append('file', f);
    fd.append('conf', imgConf);
    fetch(API + '/api/detect/image', {method:'POST', body: fd, credentials:'same-origin',
          signal: _batchAbort.signal})   // P1-3：可中止
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d && d.ok){
          okCount++;
          okItems.push({
            name: f.name, ok: true,
            record_id: d.record_id,
            image_url: d.image_url, result_url: d.result_url,
            boxes: d.boxes, stats: d.stats,
            conclusion: d.conclusion, duration_ms: d.duration_ms,
          });
        } else if(d && d.msg === '已取消'){
          cancelled = true;   // 后端感知到断开：本次不入库、不留文件；前端不再继续
          state.batchAborted = true;
        } else { failCount++; }
        idx++;
        nextOne();
      })
      .catch(function(){ if(state.batchAborted) return; failCount++; idx++; nextOne(); });  // P1-3
  }
  nextOne();
}
function renderBatchItem(){
  var items = state.batchItems||[];
  if(!items.length) return;
  var it = items[state.batchIdx];
  document.getElementById('batch-nav-label').textContent =
    (state.batchIdx+1)+' / '+items.length;
  document.getElementById('batch-prev').disabled = (state.batchIdx<=0);
  document.getElementById('batch-next').disabled = (state.batchIdx>=items.length-1);
  // 文案按批次内容对齐：图片「上一张/下一张」，视频「上一个/下一个」
  var _pv=document.getElementById('batch-prev'), _nx=document.getElementById('batch-next');
  var _isV=false;
  items.forEach(function(x){ if(x && x.isVideo) _isV=true; });
  if(_pv){ _pv.textContent = _isV ? '◀ 上一个' : '◀ 上一张'; _pv.title='快捷键：← 左方向键'; }
  if(_nx){ _nx.textContent = _isV ? '下一个 ▶' : '下一张 ▶'; _nx.title='快捷键：→ 右方向键'; }
  if(it.isVideo){
    // 批量视频项：右侧按「单视频结果」渲染（原始视频+前端逐帧框+明细表）
    document.querySelector('#detect-result .result-imgs').style.display='none';
    document.getElementById('video-result').style.display='block';
    document.querySelector('#detect-result .summary-card h4').textContent =
      buildDetectSummary(it, true);   // 批量视频项展开自后端结果，含 stats/total_frames/duration_ms
    setTblNote('agg');
    renderStatsChips(it.stats, 'detect-stats-wrap');
    // 明细表：与单视频一致，用代表帧（第一个检测到目标的帧）的框
    var tbody = document.querySelector('#detect-result table.data tbody');
    if(tbody){
      tbody.innerHTML='';
      (it.boxes||[]).forEach(function(b){
        var tr=document.createElement('tr');
        tr.innerHTML='<td>'+b.cls_name+'</td><td>'+b.conf+'</td><td>'+
          b.x1+', '+b.y1+', '+b.x2+', '+b.y2+'</td>';
        tbody.appendChild(tr);
      });
    }
    // 图表带上整批数据（可切到「本批次」视图比较各视频）
    vizSetData({mode:'batch-video', boxes:it.boxes, stats:it.stats,
                name:it.name, items:items, frames:null});
    renderVideoResult(it);
    return;
  }
  // 批量图片项：恢复图片展示形态（防止从视频结果页翻过来残留）
  document.querySelector('#detect-result .result-imgs').style.display='flex';
  document.getElementById('video-result').style.display='none';
  renderImageResult({
    image_url: it.image_url, result_url: it.result_url, record_id: it.record_id,
    boxes: it.boxes, stats: it.stats,
    conclusion: it.conclusion, duration_ms: it.duration_ms,
  });
  // 图表带上整批数据（可切到「本批次」视图比较各图）
  vizSetData({mode:'batch-image', boxes:it.boxes, stats:it.stats,
              name:it.name, items:items, frames:null});
}
function prevBatchItem(){
  if(state.batchIdx>0){ state.batchIdx--; renderBatchItem(); }
}
function nextBatchItem(){
  if(state.batchIdx<(state.batchItems||[]).length-1){ state.batchIdx++; renderBatchItem(); }
}
// 批量结果翻页快捷键：← 上一张 / → 下一张
// 生效条件：智能检测页 + 批量图片或批量视频面板 + 有 2 个以上结果；
// 焦点在输入框内、弹窗或放大层打开时不抢键。
document.addEventListener('keydown', function(e){
  if(e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  var t = e.target || {};
  var tag = (t.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
  if(document.querySelector('.modal-mask.show')) return;
  var lb = document.getElementById('lightbox');
  if(lb && lb.style.display && lb.style.display !== 'none') return;
  var view = document.getElementById('view-detect');
  if(!view || !view.classList.contains('active')) return;
  var panel = document.querySelector('.source-panel.active');
  if(!panel) return;
  var pid = panel.id || '';
  if(pid !== 'src-batch-image' && pid !== 'src-batch-video') return;
  if((state.batchItems || []).length < 2) return;
  e.preventDefault();
  if(e.key === 'ArrowLeft') prevBatchItem(); else nextBatchItem();
});

// ===== 批量视频检测（队列逐个调用单视频接口） =====
state.batchVideoFiles = [];
function onBatchVideosPicked(input){
  var files = Array.from(input.files);
  if(!files.length) return;
  // P1-1/P1-2：数量 + 总大小 软限制（前端拦截，服务端仍会兜底）
  if(files.length > MAX_BATCH_VIDEO_FILES){
    toast('批量视频最多 '+MAX_BATCH_VIDEO_FILES+' 个，已选 '+files.length+' 个，请精简后重试');
    input.value='';
    return;
  }
  var totalMB = files.reduce(function(s,f){ return s + f.size; }, 0) / 1024 / 1024;
  if(totalMB > MAX_BATCH_VIDEO_TOTAL_MB){
    toast('批量视频总大小不能超过 '+MAX_BATCH_VIDEO_TOTAL_MB+' MB（'+(MAX_BATCH_VIDEO_TOTAL_MB/1024).toFixed(0)+' GB），当前约 '+totalMB.toFixed(0)+' MB');
    input.value='';
    return;
  }
  // P1-4：按大小/时长预检，剔除超限视频（服务端仍会兜底校验）
  Promise.all(files.map(precheckVideoFile)).then(function(results){
    var okFiles = [], bad = [];
    files.forEach(function(f, i){
      if(results[i].ok) okFiles.push(f);
      else bad.push(f.name+'：'+results[i].reason);
    });
    if(bad.length){
      toast('已剔除 '+bad.length+' 个不符合要求的视频：'+bad.slice(0,3).join('；')+(bad.length>3?'…':''));
    }
    if(!okFiles.length){ input.value=''; return; }
    state.batchVideoFiles = okFiles;
    var queue = document.getElementById('batch-video-queue');
    document.getElementById('batch-video-text').innerHTML =
      '已选择 <span class="hl">'+state.batchVideoFiles.length+'</span> 个视频';
    queue.innerHTML = '';
    state.batchVideoFiles.forEach(function(f, i){
      var div = document.createElement('div');
      div.className = 'queue-item';
      div.id = 'bvq-'+i;
      div.innerHTML = '<span class="dot"></span><span>'+f.name+' — 等待中</span>';
      queue.appendChild(div);
    });
  });
}
function runBatchVideo(){
  if(!state.batchVideoFiles.length){ toast('请先选择视频'); return; }
  // P1-5：读取抽帧/置信度（仅本次批次生效，该批次内每个视频用同一设置）
  var sc = readSkipConf('bv-skip-enabled', 'bv-skip-value', 'bv-conf-value');
  if(!sc.ok){ toast(sc.msg); return; }
  var files = state.batchVideoFiles;
  var bvTotal = files.length;
  var idx = 0, okCount = 0, failCount = 0;
  var okItems = [];   // 成功项：结束后右侧内联结果区展示（与批量图片一致）
  var cancelled = false;   // 中途取消/断开：停止剩余，已完成的部分保留
  var t0 = Date.now();
  var finished = false;
  // P2-2：开始前预估磁盘（源 + 结果 ≈ 总大小 × 2），不足提前提示，避免跑到一半失败
  var totalBytes = files.reduce(function(s,f){ return s + f.size; }, 0);
  api('/api/disk/free').then(function(res){
    if(res.data && res.data.ok){
      var freeMB = res.data.free_mb || 0;
      var needMB = totalBytes * 2 / 1024 / 1024;
      if(needMB > freeMB){
        toast('磁盘剩余空间不足：预计需要约 '+needMB.toFixed(0)+' MB，当前仅剩 '+freeMB.toFixed(0)+' MB，已取消批量');
        return;
      }
    }
    startLoop();   // 预估通过（或接口异常）再开始
  }).catch(function(){ startLoop(); });

  function startLoop(){
    // P1-3：本次批量任务的 AbortController，支持中途取消（同时注册进全局任务控制）
    state.batchAborted = false;
    resetResult();   // 开始新批量：清掉右侧上次残留，显示“检测中...”
    startTask('批量视频（'+bvTotal+' 个）');
    showCancelBtn(true, cancelCurrentBatch);
    showLoading('准备处理第 1 / '+bvTotal+' 个视频...', 1800);
    next();
  }
  function finishBatch(){
    if(finished) return;
    finished = true;
    endTask();
    showCancelBtn(false);
    _batchAbort = null;
    _batchFinish = null;
    hideLoading();
    var secs = ((Date.now()-t0)/1000).toFixed(1);
    toast('批量视频'+(cancelled?'已取消':'全部完成')+'：成功 '+okCount+' / 共 '+bvTotal+' 个'
          +(failCount?('，失败 '+failCount+' 个'):''));
    // P2-3：弹出汇总（成功/失败/耗时 + 跳转历史），不再自动跳历史
    // BUG修复：批量视频此前没有右侧内联结果区（右侧始终空状态）。
    // 现与批量图片对齐：成功项进右侧「检测结果」区（原始视频+逐帧框+明细表），
    // 多个视频用上一/下一翻页；全失败/全取消时右侧维持空状态。
    state.batchItems = okItems;
    state.batchIdx = 0;
    if(okItems.length){
      document.getElementById('detect-empty').style.display='none';
      document.getElementById('detect-result').style.display='block';
      document.getElementById('batch-nav').style.display = okItems.length>1 ? 'flex':'none';
      renderBatchItem();
      // 结果就绪：点亮左侧模式占位图
      state._dvReady = true;
    }
    syncDetectVisual();   // 收尾同步（全失败/全取消时收起占位图）
    openBatchSummary({kind:'video', total:bvTotal, ok:okCount, fail:failCount, secs:secs});
  }
  _batchFinish = finishBatch;
  function next(){
    if(state.batchAborted){ finishBatch(); return; }   // P1-3：已被取消
    if(idx >= bvTotal){ finishBatch(); return; }
    var f = files[idx];
    var item = document.getElementById('bvq-'+idx);
    if(item){
      item.className = 'queue-item running';
      item.querySelector('span:last-child').textContent = f.name+' — 正在推理...';
    }
    showLoading('正在处理第 '+(idx+1)+' / '+bvTotal+' 个视频：'+f.name, 1800);
    // 进度条与单视频对齐：主条按「本视频的帧进度」走（帧总数未知前用不确定动画），
    // 「第 x / N 个」放副文字里体现批次位置
    setLoadProgress(0, 0, '第 '+(idx+1)+' / '+bvTotal+' 个　本视频帧数解析中…');
    var fd = new FormData();
    fd.append('file', f);
    fd.append('skip', sc.skip);
    fd.append('conf', sc.conf);
    fetch(API + '/api/detect/video/stream', {method:'POST', body: fd, credentials:'same-origin',
          signal: _batchAbort.signal})   // P1-3：可中止
      .then(function(r){
        if(!r.body){ return r.json(); }
        var reader=r.body.getReader(), decoder=new TextDecoder('utf-8'), buf='';
        var data=null, err=null;
        function handleLine(line){
          if(!line) return;
          var m; try{ m=JSON.parse(line); }catch(e){ return; }
          if(m.type==='progress'){
            // 主条 = 本视频帧进度；m.total 未知（未解析完）时退化为不确定动画
            setLoadProgress(m.done, m.total || 0,
              '第 '+(idx+1)+' / '+bvTotal+' 个　已处理 '+m.done+(m.total?(' / '+m.total):'')+' 帧');
          } else if(m.type==='result'){ data=m.data; }
          else if(m.type==='error'){ err=m.msg; }
        }
        function pump(){
          return reader.read().then(function(step){
            if(step.done){ if(buf.trim()) handleLine(buf.trim()); return null; }
            buf+=decoder.decode(step.value,{stream:true});
            var lines=buf.split('\n'); buf=lines.pop();
            lines.forEach(handleLine);
            return pump();
          });
        }
        return pump().then(function(){
          if(err) return {ok:false, msg:err};
          return data || {ok:false, msg:'未收到处理结果'};
        });
      })
      .then(function(d){
        if(item){
          if(d && d.ok){
            okCount++;
            okItems.push(Object.assign({name: f.name, isVideo: true}, d));
            item.className = 'queue-item done';
            var n = Object.values(d.stats||{}).reduce(function(a,b){return a+b;},0);
            item.querySelector('span:last-child').textContent = f.name+' — 完成，'+d.total_frames+' 帧 / '+n+' 目标';
          } else if(d && d.msg === '已取消'){
            // 后端感知到断开：该视频已中止、不落库、原视频已清理
            cancelled = true;
            item.className = 'queue-item';
            item.querySelector('span:last-child').textContent = f.name+' — 已取消';
          } else {
            failCount++;
            item.className = 'queue-item';
            item.querySelector('span:last-child').textContent = f.name+' — 失败：'+((d&&d.msg)||'');
          }
        }
        // 每个视频完成即同步一次（结果区要等收尾统一渲染；此处仅维持队列态显隐）
        syncDetectVisual();
        idx++;
        next();
      })
      .catch(function(e){
        if(state.batchAborted){          // P1-3：取消后不再递归
          cancelled = true;
          if(item){
            item.className = 'queue-item';
            item.querySelector('span:last-child').textContent = f.name+' — 已取消';
          }
          return;
        }
        failCount++;
        if(item){
          item.className = 'queue-item';
          item.querySelector('span:last-child').textContent = f.name+' — 请求失败';
        }
        idx++;
        next();
      });
  }
}

// ===== 检测结果可视化（ECharts 复合图） =====
// 左侧输入面板按钮下方的可视化卡（替代原 SVG 示意占位卡）。三种视图：
//   class  类别分布：各类数量柱状 + 各类平均置信度折线（右轴）+ 占比环形（默认）
//   batch  本批次：批量图/批量视频时，逐个文件的目标数堆叠条形
//   frames 帧级趋势：视频类模式，逐帧目标数量随时间的面积图
// 颜色与画面上的检测框同源（_BOX_COLORS），方便对照图表与画面。
var _vizChart = null;
var _detailChart = null;
var _detailAnimTimer = null;   // 历史详情抽屉左图：去重挂起的延迟渲染（等滑入到位后再播入场动画）
var _detailRecord = null;
var _detailView = 'class';     // 详情抽屉左图当前视图：class(类别分布) / frames(帧级趋势)
var _detailFrames = null;      // 视频逐帧 boxes（来自 boxes_url 的 frames 数组）；null=尚未加载，[]=已加载但为空
var _detailFps = 25;
var _detailNames = {};         // 视频类别 id→名称映射（boxes_url 的 names），帧级趋势 tooltip 用
var _detailFirstOpen = false;  // 本次打开是否首次渲染（首次需等抽屉滑入到位后才播动画；切视图/帧数据到达则直接播）
var _vizIO = null;             // 检测页图表懒渲染：IntersectionObserver 实例
var _vizPending = null;        // 检测页图表懒渲染：挂起的待渲染包（host/opt/card/view/legend*）
var _vizData = {mode:'image', cur:null, items:null, frames:null,
                view:'class', canBatch:false, canFrames:false};
function _vizCss(n, fb){
  try{ var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v && v.trim()) || fb; }
  catch(e){ return fb; }
}
// 统一配色（框 / 柱 / 饼 / 折线 / 图例全部走这一个）：保证「同一类别永远同色」。
// 优先按 cls_id（与框绘制完全一致：_BOX_COLORS[cls % len]）；无 cls_id 时按类别名稳定哈希兜底，
// 避免此前「图表按排序位置取色、框按 cls 取色」导致的颜色错乱与幽灵类别。
function _catColor(name, cls){
  if(typeof cls === 'number' && isFinite(cls)){
    return _BOX_COLORS[((cls % _BOX_COLORS.length) + _BOX_COLORS.length) % _BOX_COLORS.length];
  }
  var key = (name != null && String(name) !== '') ? String(name) : ('#' + (cls != null ? cls : '?'));
  var h = 0;
  for(var i = 0; i < key.length; i++){ h = (h * 31 + key.charCodeAt(i)) >>> 0; }
  return _BOX_COLORS[h % _BOX_COLORS.length];
}
function _vizColor(name, cls){
  return _catColor(name, cls);
}
function _vizGrad(hex){
  return new echarts.graphic.LinearGradient(0, 0, 0, 1,
    [{offset:0, color: hex}, {offset:1, color: _boxFill(hex, .32)}]);
}
// 按类别汇总：数量优先取后端 stats（视频为全片统计），置信度为该类所有框的均值
function vizAggregate(boxes, stats){
  var order = [], map = {};
  function get(name, cls){
    if(!map[name]){
      map[name] = {name:name, cls:cls, boxCount:0, confSum:0, confN:0};
      order.push(name);
    }
    return map[name];
  }
  (boxes || []).forEach(function(b){
    var name = b.cls_name || ('类别' + (b.cls !== undefined ? b.cls : '?'));
    var m = get(name, b.cls);
    m.boxCount++;
    var c = parseFloat(b.conf);
    if(!isNaN(c)){ m.confSum += c; m.confN++; }
  });
  if(stats){ for(var k in stats){ get(k, undefined); } }
  var out = order.map(function(n, i){
    var m = map[n];
    var cnt = (stats && (n in stats)) ? (stats[n] || 0) : m.boxCount;
    return {name:n, count:cnt, avg: m.confN ? (m.confSum / m.confN) : 0,
            color: _vizColor(m.name, m.cls)};
  });
  out = out.filter(function(x){ return x.count > 0; });   // 丢弃 0 计数的幽灵类别
  out.sort(function(a, b){ return b.count - a.count; });
  return out;
}
function vizSetData(o){
  o = o || {};
  _vizData.mode = o.mode || 'image';
  _vizData.cur = {boxes: o.boxes || [], stats: o.stats || {}, name: o.name || ''};
  // items/frames 未显式提供时保留原值：批量翻页会先经 renderImageResult 调一次
  // 不带 items 的 setData，若在此清空会把用户停留的视图强制切回「类别分布」。
  // 切换检测模式（单图/单视频）时由调用方显式传 items:null / frames:null 清掉旧批次。
  if(o.items !== undefined){
    _vizData.items = (o.items && o.items.length > 1) ? o.items : null;
  }
  _vizData.canBatch = !!_vizData.items;
  if(o.frames !== undefined){
    _vizData.frames = (o.frames && o.frames.length) ? o.frames : null;
  }
  _vizData.canFrames = !!_vizData.frames;
  if(_vizData.view === 'batch' && !_vizData.canBatch) _vizData.view = 'class';
  if(_vizData.view === 'frames' && !_vizData.canFrames){
    // 视频模式：帧时间轴是异步取到的，翻页时短暂为空属正常，
    // 等 vizUpdateFrames 补齐后再渲染，不急着把视图打回「类别分布」
    var vm = (_vizData.mode === 'video' || _vizData.mode === 'batch-video');
    if(!vm) _vizData.view = 'class';
  }
  syncDetectVisual();   // 显隐就绪后由 syncDetectVisual 触发 _vizRender
}
function _vizDisposeChart(){
  if(!_vizChart) return;
  var dom = _vizChart.getDom();
  try{ _vizChart.dispose(); }catch(e){}
  if(dom && dom.parentNode) dom.parentNode.removeChild(dom);
  _vizChart = null;
}
// —— 检测页图表懒渲染 ——
// 检测完成时图表可能位于屏幕下方（需滚动才看得到）。若立即渲染，入场动画会在用户看不见
// 的地方播完，滚下去已错过。故：图表未暴露足够比例时先挂起，等滚动暴露到 ≥20% 再真正
// 创建实例并播放入场动画；已暴露则立即播放。历史详情抽屉(_detailChart)不受影响（它本就等滑入到位才播）。
function _vizEnsureIO(){
  if(_vizIO || typeof IntersectionObserver === 'undefined') return _vizIO;
  _vizIO = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting && e.intersectionRatio >= 0.2){
        if(_vizPending && e.target === _vizPending.host){
          var p = _vizPending; _vizPending = null;
          try{ _vizIO.unobserve(p.host); }catch(err){}
          _vizDoRender(p);
        }
      }
    });
  }, {threshold: [0, 0.2, 1]});
  return _vizIO;
}
function _vizIsExposed(host){
  var rect = host.getBoundingClientRect();
  var vh = (window.innerHeight || document.documentElement.clientHeight);
  var visibleH = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
  if(visibleH <= 0) return false;
  return (visibleH / rect.height) >= 0.2;   // 暴露 ≥20% 才视为“可见”，立即播放
}
function _vizDoRender(p){
  var host = p.host, opt = p.opt, card = p.card;
  _clearChartSkeleton(host);   // 真正渲染时移除骨架屏，露出入场动画
  if(typeof echarts === 'undefined'){
    var em = card.querySelector('.viz-empty');
    if(em){ em.classList.add('show'); em.textContent = '图表库未加载'; host.style.display = 'none'; }
    return;
  }
  // 每次重建实例（复用同一内层 .viz-cv，避免 canvas 无限累积），强制重播 ECharts 原生入场动画
  // （柱长高/折线沿 X 轴依次描出/环形展开）。单纯 setOption(notMerge) 在翻页/切视图等数据更新时
  // 会被 ECharts 吞掉初始动画，只会留折线及其数字过渡，所以必须重建实例。
  if(_vizChart){ try{ _vizChart.dispose(); }catch(e){} _vizChart = null; }
  var cv = host.querySelector('.viz-cv');
  if(!cv){
    cv = document.createElement('div');
    cv.className = 'viz-cv';
    cv.style.width = '100%'; cv.style.height = '100%';
    host.appendChild(cv);
  }
  _vizChart = echarts.init(cv);
  _vizChart.setOption(opt, true);
  // 注意：此处不能紧接着 resize()——同步 resize 会打断柱/饼几何入场动画（只剩折线标签
  // 数字在动），导致柱/饼“闪现”。容器尺寸 init 时已由 host 显式高度 + 可见宽度读取正确。
  // 图例仅在类别视图渲染
  if(p.view === 'class'){
    _vizRenderLegend(card, p.legendList, p.legendTotal);
  }else{
    var lg = card.querySelector('.viz-legend');
    if(lg){ lg.innerHTML = ''; lg.style.display = 'none'; }
  }
}
function vizReset(){
  _vizDisposeChart();
  _vizData.cur = null; _vizData.items = null; _vizData.frames = null;
  _vizData.canBatch = false; _vizData.canFrames = false; _vizData.view = 'class';
  // 清空四块可视化卡骨架（下次结果出现时重建）
  Array.prototype.forEach.call(document.querySelectorAll('.detect-visual'), function(el){
    el.removeAttribute('data-filled');
    el.innerHTML = '';
  });
}
function switchDetectChart(view){
  _vizData.view = view;
  _vizRender();
}
// 类别分布视图的动态布局：类别数不可预知，容器高度随类别数伸展，
// 避免标签/引导线在固定高度里互相重叠。返回 {h:容器高, cy:饼中心y(像素)}。
/* ===================== 可视化调参区（改这里即可，别处不用动） =====================
 * 类别分布 = 上下三段：① 柱图+折线  ② 环形图  ③ 下方类别清单（HTML）
 * 所有数值单位均为像素；改完保存后 Ctrl+F5 硬刷新生效。
 */
var _VIZ_TUNE = {
  /* —— ① 柱图 + 折线区 —— */
  gridTop:  44,     // 顶部图例（目标数/平均置信度）→ 柱图顶 的距离
  gridH:    240,    // 柱图区总高（含底部 x 轴类别名，柱子高度随之变化）

  /* —— ② 环形图区 —— */
  pieTopGap:55,     // x 轴类别名底 → 环形顶（引导线标签会向上伸出约 46px，建议 ≥40）
  pieR:     90,     // 环形外半径（越大环越大）
  pieInR:   52,     // 环形内半径（越小环带越粗）
  pieBottom:10,     // 环形底 → 图表画布底
  pieLabels:5,      // 环形图上引导线标签数量（标占比前 N 个，建议 ≤6）

  /* —— ③ 类别清单 —— */
  legendMax:12,     // 清单最多列出前 N 个类别，其余归入"另有 N 类"提示

  /* —— 柱图 x 轴 —— */
  xRotate8: 30,     // 类别数 > 8 时类别名的旋转角度
  xRotate5: 28,     // 类别数 > 5 时类别名的旋转角度（否则不旋转）
  xThin:    15,     // 类别数超过此值 → x 轴标签自动抽稀（防横向挤爆）
  lineLbl:  15,     // 类别数超过此值 → 折线百分比标签隐藏（数值改看 tooltip）

  /* —— 帧级趋势视图高度：h = base + 峰值目标数 * step，夹在 min~max —— */
  framesBase:100, framesStep:60, framesMin:100, framesMax:480,

  /* —— 本批次视图高度：h = base + 文件数 * step，下限 min —— */
  batchBase: 130,  batchStep: 46,  batchMin:  200,

  /* —— 本批次 / 帧级趋势 专有：图表底 → 底部说明文字 的额外间距 ——
     只对这两个视图生效；类别分布走 CSS 的 --viz-legend-bot / --viz-cap-gap，互不影响 */
  subCapGap: 1
};
var _VIZ_PIE_MAX = _VIZ_TUNE.legendMax;      // 兼容旧引用
var _VIZ_PIE_LABELS = _VIZ_TUNE.pieLabels;   // 兼容旧引用
// 环形图不再使用"引导线外挂标签"：多类别长尾场景下标签排布由图表库自行决定，
// 会出现"丢标签 / 顺序错乱 / 标签与扇区对不上"。改由 _vizRenderLegend 用 HTML 图例
// 列出类别（颜色与扇区同源、严格按占比降序），高度因此可固定不再暴涨。
function _vizClassLayout(){
  // 上下布局：① 柱 + 折线 ② 环形图（带外挂标签，用满整个宽度不再与图例争位）
  // ③ 下方类别清单（ECharts 图例，横向自动换行）+ 底部"另有 N 类"提示行
  var T = _VIZ_TUNE;
  var gridTop = T.gridTop, gridH = T.gridH;
  var gridBottom = gridTop + gridH;
  var R = T.pieR;
  var cy = gridBottom + T.pieTopGap + R;
  return {h: cy + R + T.pieBottom, cy: cy, R: R,
          inR: T.pieInR, gridTop: gridTop, gridH: gridH};
}
function _vizOptClass(list, layout){
  if(!list) list = [];
  var total = list.reduce(function(s, x){ return s + x.count; }, 0);
  var c1 = _vizCss('--text', '#e6eaf2'), c2 = _vizCss('--text-2', '#9aa4b2');
  var c3 = _vizCss('--text-3', '#6b7482');
  var line = _vizCss('--line', 'rgba(255,255,255,.12)');
  var accent = _vizCss('--accent', '#c9986b');
  var names = list.map(function(x){ return x.name; });
  var avgs = list.map(function(x){ return +(x.avg * 100).toFixed(2); });
  // 上下布局（左侧面板宽度有限，左右放不下两块图）：
  //   上半：各类数量柱 + 平均置信度折线（右轴）
  //   下半：类别占比环形图，环心显示合计
  return {
    backgroundColor:'transparent',
    // 显式开启入场动画：柱从 X 轴长高、折线从 0 上涨、环形图旋转展开。
    // 注意：调用方不得在 setOption 后立刻 resize()，否则会打断几何入场动画
    // （只剩折线标签的 valueAnimation 在动），导致柱/饼“闪现”。
    animation: true,
    animationDuration: 900,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 600,
    animationEasingUpdate: 'cubicInOut',
    tooltip:{trigger:'axis', axisPointer:{type:'shadow'},
      backgroundColor:'rgba(18,22,30,.95)', borderColor:line, textStyle:{color:c2, fontSize:12}},
    legend:[
      {data:['目标数', '平均置信度'], top:0, left:'center', itemWidth:12, itemHeight:8,
       itemGap:14, textStyle:{color:c2, fontSize:11}},
      // 右侧类别清单：颜色与扇区同源、严格按占比降序、显示 名称 数量（占比）
    ],
    grid:{left:6, right:8, top:layout.gridTop, height:layout.gridH, containLabel:true},
    xAxis:{type:'category', data:names, axisTick:{show:false},
      axisLine:{lineStyle:{color:line}},
      axisLabel:{color:c2, fontSize:11,
        interval: names.length > _VIZ_TUNE.xThin ? 'auto' : 0,
        rotate: names.length > 8 ? _VIZ_TUNE.xRotate8
              : (names.length > 5 ? _VIZ_TUNE.xRotate5 : 0)}},
    yAxis:[
      {type:'value', name:'数量', nameTextStyle:{color:c2, fontSize:11},
       axisLabel:{color:c2, fontSize:11}, minInterval:1,
       splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}}},
      {type:'value', name:'置信度%', min:0, max:100, nameTextStyle:{color:c2, fontSize:11},
       axisLabel:{color:c2, fontSize:11, formatter:'{value}'}, splitLine:{show:false}}
    ],
    series:[
      {name:'目标数', type:'bar', barWidth:'44%',
       data:list.map(function(x){
         return {value:x.count, itemStyle:{color:_vizGrad(x.color), borderRadius:[6, 6, 0, 0]}};
       }),
       label:{show:true, position:'top', color:c2, fontSize:11}},
      {name:'平均置信度', type:'line', yAxisIndex:1, data:avgs, smooth:true,
       symbol:'circle', symbolSize:7, lineStyle:{width:2.4, color:accent},
       itemStyle:{color:accent}, z:5,
       // 类别多时百分比标签横向必然互相压住，关闭（数值走 tooltip）
       label:{show: names.length <= _VIZ_TUNE.lineLbl, position:'top', color:accent,
              fontSize:10.5, formatter:'{c}%'}},
      {name:'类别占比', type:'pie', center:['50%', layout.cy], radius:[layout.inR, layout.R],
       animationType:'expansion',   // 从起始角扫开（旋转展开），而非默认中心缩放
       // 外挂标签只标占比前 5：上下布局下环形区用满整个宽度，标签有充足空间
       data:list.map(function(x, i){
         var showLbl = i < _VIZ_PIE_LABELS;
         return {name:x.name, value:x.count,
                 label:{show:showLbl}, labelLine:{show:showLbl},
                 itemStyle:{color:x.color, borderColor:'rgba(0,0,0,.28)', borderWidth:2}};
       }),
       label:{color:c2, fontSize:10.5, lineHeight:16, formatter:'{b}\n{d}%'},
       labelLine:{length:14, length2:12, lineStyle:{color:line}},
       tooltip:{trigger:'item', formatter:'{b}：{c}（{d}%）'}}
    ],
    title:{text: String(list.length), subtext:'类别数', left:'center', top: layout.cy - 18, silent:true,
      textStyle:{color:c1, fontSize:20, fontWeight:700},
      subtextStyle:{color:c2, fontSize:11}},
  };
}
/* ===================== 详情抽屉左图调参区（改这里即可） =====================
 * 与检测页的 _VIZ_TUNE 完全独立，互不影响。
 * 布局：上方柱图+折线区高度固定；环形图在剩余空间里垂直居中、半径尽量撑大。
 */
var _DETAIL_VIZ_TUNE = {
  gridTop:  55,    // 顶部图例 → 柱图顶 的距离
  gridH:    250,   // 柱图+折线区固定高度（不再随容器拉伸，改这里调上方图的高矮）
  pieRMax:  100,   // 环形外半径上限（实际还会受剩余高度/栏宽限制，想更大就调它）
  pieRatio: 0.58,  // 环形内半径 = 外半径 × 此比例（越小环带越粗）
  gapMin:   70,    // 环形上下最小留白（要容纳引导线标签，建议 ≥50）

  /* —— 入场动画延迟（毫秒）：等抽屉滑入(.28s)到位后再渲染，让原生动画（柱长高/折线涨/环形展开）在到位后播放。
     需 ≥ 抽屉 CSS transition(.28s=280ms)；改大了只会更晚播，不影响形态。不要设 0，否则动画会跟着滑动一起播。 */
  animDelay: 320
};
// 历史详情抽屉左侧：复用类别分布（柱+折线+环形）图表，数据源来自该条记录自身的 boxes/stats。
// 图表区始终自适应占满左栏剩余垂直高度（左右两栏高度各自独立，互不共用）：
// 上方柱图区高度固定（_DETAIL_VIZ_TUNE.gridH），环形图在剩余空间内垂直居中并尽量放大；
// 高度不足时回退到 _vizClassLayout 默认布局（可滚动）。
function renderDetailChart(r){
  var host = document.getElementById('detail-viz-chart');
  var empty = document.getElementById('detail-viz-empty');
  var sw = document.getElementById('detail-viz-switch');
  var sub = document.getElementById('detail-viz-sub');
  var title = document.getElementById('detail-viz-title');
  if(!host || !r) return;
  if(_detailAnimTimer){ clearTimeout(_detailAnimTimer); _detailAnimTimer = null; }   // 取消上一次未触发的延迟渲染
  _detailRecord = r;
  // 每次打开重置视图为“类别分布”，并清掉上一轮的帧数据/状态。
  _detailView = 'class';
  _detailFrames = null;
  _detailFps = 25;
  _detailNames = {};
  _detailFirstOpen = true;
  // 立即销毁上一个详情页的图表实例：避免打开新详情时左图区残留旧图表（滑入途中闪现旧数据），
  // 延迟渲染期间左图区保持空白，等抽屉滑入到位后再重建并播放入场动画。
  if(_detailChart){ try{ _detailChart.dispose(); }catch(e){} _detailChart = null; }
  // 立即清掉上一轮图例：旧记录的图例与图表是兄弟节点、_vizRenderLegend 在 320ms 延迟渲染时才重写，
  // 不清会在抽屉滑入途中闪现“上一条详情”的图例。与图表骨架同期清空，延迟渲染期间左图区与图例均保持空白。
  _vizRenderLegend(host.parentNode, null, 0);
  // 等待抽屉滑入到位期间先铺骨架屏（环形/坐标轴），避免左图区空白“闪现”
  _showChartSkeleton(host, 'class');
  // 帧级趋势按钮默认隐藏；仅视频且有时间轴时再显示（图片记录无“帧”概念，永远不显示）。
  _detailShowFramesBtn(sw, false);
  _detailSyncSwitch(sw, sub, title);
  if(typeof echarts === 'undefined'){
    if(empty){ empty.style.display = 'block'; empty.textContent = '图表库未加载'; }
    host.style.display = 'none';
    return;
  }
  var isVideo = (r.result_url||'').toLowerCase().endsWith('.mp4') ||
                (r.image_name||'').toLowerCase().endsWith('.mp4');
  // 视频：异步取逐帧数据（boxes_url 里的 frames 数组），供“帧级趋势”视图使用。
  if(isVideo && r.boxes_url){
    if(state.detailVideoBoxes && state.detailVideoBoxes.length){
      _detailFrames = state.detailVideoBoxes;
      _detailFps = state.detailVideoFps || 25;
      _detailNames = state.detailVideoNames || {};
      _detailShowFramesBtn(sw, true);
    }else{
      fetch(API + r.boxes_url, {credentials:'same-origin'})
        .then(function(res){ return res.json(); })
        .then(function(tl){
          if(_detailRecord !== r) return;   // 用户已打开别的记录，丢弃本次过期结果
          _detailFrames = tl.frames || [];
          _detailFps = tl.fps || 25;
          _detailNames = tl.names || {};
          _detailShowFramesBtn(sw, !!_detailFrames.length);
          if(_detailView === 'frames') _renderDetailChartNow();   // 已切到帧视图则数据到达后补渲染
        })
        .catch(function(){});
    }
  }
  // 类别视图：延迟到抽屉滑入(.28s)到位后再渲染，重建实例播放入场动画（柱长高/折线描出/环形扫开）。
  _detailAnimTimer = setTimeout(function(){
    _detailAnimTimer = null;
    _detailFirstOpen = false;
    _renderDetailChartNow();
  }, _DETAIL_VIZ_TUNE.animDelay);
}
// 视图切换按钮（点击“类别分布/帧级趋势”）：抽屉已打开，直接渲染、无需等滑入。
function detailSwitchView(v){
  if(_detailView === v) return;
  _detailView = v;
  var sw = document.getElementById('detail-viz-switch');
  var sub = document.getElementById('detail-viz-sub');
  var title = document.getElementById('detail-viz-title');
  _detailSyncSwitch(sw, sub, title);
  _renderDetailChartNow();
}
// 同步按钮 active 态 + 标题/副标题文案。
function _detailSyncSwitch(sw, sub, title){
  if(sw){
    Array.prototype.forEach.call(sw.querySelectorAll('.viz-btn'), function(b){
      b.classList.toggle('active', b.getAttribute('data-view') === _detailView);
    });
  }
  if(title) title.textContent = (_detailView === 'frames') ? '帧级趋势' : '类别分布';
  if(sub) sub.textContent = (_detailView === 'frames')
    ? '逐帧目标数量随时间变化（采样展示）'
    : '按类别统计目标数量与平均置信度';
}
function _detailShowFramesBtn(sw, show){
  if(!sw) return;
  var b = sw.querySelector('[data-view="frames"]');
  if(b) b.style.display = show ? '' : 'none';
}
// 真正渲染当前视图（重建实例 → setOption 强制重播入场动画；抽屉已可见时调用，无滑入延迟）。
function _renderDetailChartNow(){
  var host = document.getElementById('detail-viz-chart');
  var empty = document.getElementById('detail-viz-empty');
  if(!host) return;
  _clearChartSkeleton(host);   // 真正渲染时移除骨架屏，露出入场动画
  if(_detailChart){ try{ _detailChart.dispose(); }catch(e){} _detailChart = null; }   // 重建实例，强制重播入场动画
  if(_detailView === 'class'){
    var r = _detailRecord;
    if(!r){ return; }
    var list = vizAggregate(r.boxes, r.stats);
    var total = list.reduce(function(s, x){ return s + x.count; }, 0);
    if(!total){
      if(empty){ empty.style.display = 'block'; empty.textContent = '该记录暂无检测数据'; }
      host.style.display = 'none';
      _vizRenderLegend(host.parentNode, null, 0);   // 无数据时清掉图例
      return;
    }
    if(empty) empty.style.display = 'none';
    host.style.display = 'block';
    _vizRenderLegend(host.parentNode, list, total);   // 环形图下方 HTML 图例（与检测页/网络流同款）
    var T = _DETAIL_VIZ_TUNE;
    var H = host.clientHeight, W = host.clientWidth;
    var leftover = H - T.gridTop - T.gridH;
    var R = Math.round(Math.min(T.pieRMax, (leftover - 2 * T.gapMin) / 2, (W - 36) / 2));
    var layout;
    if(H > 80 && R >= 60){
      var topGap = (leftover - 2 * R) / 2;   // 环形在剩余空间内垂直居中，上下留白均分
      layout = {h:H, cy:T.gridTop + T.gridH + topGap + R, R:R, inR:Math.round(R*T.pieRatio),
                gridTop:T.gridTop, gridH:T.gridH};
    }else{
      layout = _vizClassLayout();   // 高度不足兜底：默认固定布局，容器可滚动
    }
    host.style.height = layout.h + 'px';
    try{ _detailChart = echarts.init(host); _detailChart.setOption(_vizOptClass(list, layout), true); }catch(e){}
  }else{ // 帧级趋势
    if(!_detailFrames || !_detailFrames.length){
      if(empty){
        empty.style.display = 'block';
        empty.textContent = (_detailFrames === null) ? '正在加载帧数据…' : '该视频暂无逐帧数据';
      }
      host.style.display = 'none';
      _vizRenderLegend(host.parentNode, null, 0);   // 帧级趋势视图无类别图例
      return;
    }
    if(empty) empty.style.display = 'none';
    host.style.display = 'block';
    _vizRenderLegend(host.parentNode, null, 0);     // 帧级趋势视图无类别图例
    var Hh = host.clientHeight;
    host.style.height = (Hh > 80 ? Hh : 360) + 'px';   // 面积图占满左栏高度
    try{ _detailChart = echarts.init(host); _detailChart.setOption(_vizFramesOption(_detailFrames, _detailFps, _detailNames), true); }catch(e){}
  }
}
function _vizShortName(n, max){
  n = String(n || '');
  max = max || 12;
  return n.length > max ? (n.slice(0, max - 1) + '…') : n;
}
function _vizOptBatch(){
  var items = _vizData.items || [];
  var c2 = _vizCss('--text-2', '#9aa4b2');
  var line = _vizCss('--line', 'rgba(255,255,255,.12)');
  var clsList = [], idx = {}, clsMap = {};
  items.forEach(function(it){
    var st = it.stats || {};
    for(var k in st){ if(!(k in idx)){ idx[k] = clsList.length; clsList.push(k); } }
    // 取每个类别的 cls_id，使「本批次」堆叠图与「类别分布」图、框颜色完全一致
    (it.boxes || []).forEach(function(b){
      if(b && b.cls_name != null && clsMap[b.cls_name] == null && typeof b.cls === 'number'){
        clsMap[b.cls_name] = b.cls;
      }
    });
  });
  var names = items.map(function(it, i){ return '#' + (i + 1) + ' ' + _vizShortName(it.name); });
  // 图例按每行约 6 项估算行数，绘图区顶部 = 24 + 行数*20，保证图例与柱子之间有间隔
  var rows = Math.max(1, Math.ceil(clsList.length / 6));
  return {
    backgroundColor:'transparent',
    tooltip:{trigger:'axis', axisPointer:{type:'shadow'},
      backgroundColor:'rgba(18,22,30,.95)', borderColor:line, textStyle:{color:c2, fontSize:12}},
    legend:{data:clsList, top:0, right:0, itemWidth:12, itemHeight:8,
      textStyle:{color:c2, fontSize:11}},
    grid:{left:6, right:16, top:24 + rows * 20, bottom:46, containLabel:true},
    // x 轴标题居中排在轴下方（原来 nameLocation:'end' 挂在轴末端向右伸出被裁掉）
    xAxis:{type:'value', name:'目标数', nameLocation:'middle', nameGap:26,
      nameTextStyle:{color:c2, fontSize:11},
      axisLabel:{color:c2, fontSize:11}, minInterval:1,
      splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}}},
    yAxis:{type:'category', data:names, inverse:true, axisTick:{show:false},
      axisLine:{lineStyle:{color:line}}, axisLabel:{color:c2, fontSize:11}},
    series:clsList.map(function(cn, i){
      return {name:cn, type:'bar', stack:'total', barWidth:'58%',
        itemStyle:{color:_catColor(cn, clsMap[cn])},
        data:items.map(function(it){ return (it.stats && it.stats[cn]) || 0; })};
    })
  };
}
function _vizOptFrames(){
  return _vizFramesOption(_vizData.frames || [], state.videoFps || 25, state.videoNames || {});
}
// 帧级趋势视图（面积图）：取逐帧目标数，按时间采样展示。抽出来可复用于详情抽屉（传入记录自身的 frames）。
// names：类别 id→名称映射（帧框为 [cid, conf, x1, y1, x2, y2] 数组，类别名要经它翻译）。
function _vizFramesOption(arr, fps, names){
  var c2 = _vizCss('--text-2', '#9aa4b2');
  var line = _vizCss('--line', 'rgba(255,255,255,.12)');
  var accent = _vizCss('--accent', '#c9986b');
  var step = Math.max(1, Math.ceil(arr.length / 140));
  var xs = [], ys = [], sampleBoxes = [];   // sampleBoxes[k] 与 xs/ys 同序：第 k 个采样点对应的该帧框数组
  for(var i = 0; i < arr.length; i += step){
    var fb = arr[i] || [];
    xs.push(+(i / fps).toFixed(1));
    ys.push(fb.length);
    sampleBoxes.push(fb);
  }
  // 单个框 → 类别名：帧框是数组 [cid, conf, x1,y1,x2,y2]，对象形态为防御性兼容
  function _boxName(b){
    if(Array.isArray(b)) return (names && names[String(b[0])]) || ('类别' + b[0]);
    if(b && typeof b === 'object'){
      return b.cls_name || (b.cls !== undefined ? (names && names[String(b.cls)]) || ('类别' + b.cls) : '未知');
    }
    return '未知';
  }
  return {
    backgroundColor:'transparent',
    tooltip:{trigger:'axis', confine:true,
      backgroundColor:'rgba(18,22,30,.95)', borderColor:line, textStyle:{color:c2, fontSize:12},
      // 限制最大宽度 + 允许换行：类别特别多时黑框不会撑出视图范围；长类别名也自动折行
      extraCssText:'max-width:260px;white-space:normal;word-break:break-word;line-height:18px;',
      formatter:function(ps){
        var p = ps && ps[0];
        if(!p) return '';
        var boxes = sampleBoxes[p.dataIndex] || [];
        var lines = ['第 ' + p.dataIndex + ' 采样点（约 ' + p.axisValue + ' s）',
                     '该帧目标数：' + p.data];
        if(boxes.length){
          // 聚合该帧各类别数量（同一类别出现多次计次数）
          var byCls = {}, order = [];
          boxes.forEach(function(b){
            var n = _boxName(b) || '未知';
            if(!(n in byCls)){ byCls[n] = 0; order.push(n); }
            byCls[n]++;
          });
          lines.push('该帧类别：');
          order.forEach(function(n){ lines.push('· ' + n + ' ×' + byCls[n]); });
        }else{
          lines.push('该帧类别：无');
        }
        return lines.join('<br/>');
      }},
    // 手动留边（不用 containLabel）：left 容纳竖排 y 轴标题，bottom 容纳 x 轴标题
    grid:{left:64, right:24, top:46, bottom:60},
    xAxis:{type:'category', data:xs, name:'时间（秒）', nameLocation:'middle',
      nameGap:28,
      nameTextStyle:{color:c2, fontSize:11}, axisTick:{show:false},
      axisLine:{lineStyle:{color:line}},
      axisLabel:{color:c2, fontSize:11, interval:Math.max(1, Math.floor(xs.length / 8))}},
    yAxis:{type:'value', name:'该帧目标数', nameLocation:'middle', nameRotate:90,
      nameGap:50, nameTextStyle:{color:c2, fontSize:11},
      axisLabel:{color:c2, fontSize:11}, minInterval:1,
      splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}}},
    series:[{name:'帧目标数', type:'line', smooth:true, symbol:'none',
      data:ys, lineStyle:{width:2, color:accent},
      areaStyle:{color:new echarts.graphic.LinearGradient(0, 0, 0, 1,
        [{offset:0, color:_boxFill(accent, .42)}, {offset:1, color:_boxFill(accent, 0)}])}}]
  };
}
// 视频时间轴到位后补齐「帧级趋势」视图（帧数据在 renderVideoResult 里异步取到）
function vizUpdateFrames(){
  if(!state.videoBoxes || !state.videoBoxes.length) return;
  _vizData.frames = state.videoBoxes;
  _vizData.canFrames = true;
  syncDetectVisual();
}
function _vizRender(){
  var card = _vizActiveCard();
  if(!card || !card.classList.contains('show')) return;   // 只渲染当前激活面板的可视化卡
  var host = card.querySelector('.viz-chart-host');
  var em = card.querySelector('.viz-empty');
  var sw = card.querySelector('.viz-switch');
  if(!host) return;
  // 视图按钮可见性：只有批量/帧数据存在时才出现
  if(sw){
    sw.style.display = (_vizData.canBatch || _vizData.canFrames) ? 'flex' : 'none';
    Array.prototype.forEach.call(sw.querySelectorAll('.viz-btn'), function(b){
      var v = b.getAttribute('data-view');
      var hide = (v === 'batch' && !_vizData.canBatch) || (v === 'frames' && !_vizData.canFrames);
      b.style.display = hide ? 'none' : '';
      b.classList.toggle('active', v === _vizData.view);
    });
  }
  // 空态判定：按「当前视图」取对应数据源（本批次视图看整批，类别/帧级看当前项）
  var cur = _vizData.cur;
  var stats = (cur && cur.stats) || {};
  var total = 0, bt = 0;
  for(var k in stats){ total += (stats[k] || 0); }
  (_vizData.items || []).forEach(function(it){
    var st = it.stats || {};
    for(var kk in st){ bt += (st[kk] || 0); }
  });
  var isVideoMode = (_vizData.mode === 'video' || _vizData.mode === 'batch-video');
  var hasData, emptyMsg;
  if(_vizData.view === 'batch'){
    hasData = bt > 0;
    emptyMsg = '本批次所有文件均未检测到目标';
  }else if(_vizData.view === 'frames'){
    hasData = !!(_vizData.frames && _vizData.frames.length);
    emptyMsg = '暂无帧级数据';
  }else{
    hasData = !!cur && (total > 0 || (cur.boxes && cur.boxes.length));
    emptyMsg = !cur ? '暂无可视化数据'
             : (isVideoMode ? '该视频未检测到目标' : '该图片未检测到目标');
  }
  if(!hasData){
    host.style.display = 'none';
    if(em){ em.classList.add('show'); em.textContent = emptyMsg; }
    if(_vizPending && _vizPending.host === host){   // 数据变空：取消挂起的懒渲染
      if(_vizIO){ try{ _vizIO.unobserve(host); }catch(e){} }
      _vizPending = null;
    }
    _vizDisposeChart();
    _clearChartSkeleton(host);
    var lg0 = card.querySelector('.viz-legend');
    if(lg0){ lg0.innerHTML = ''; lg0.style.display = 'none'; }
    return;
  }
  if(em) em.classList.remove('show');
  host.style.display = 'block';
  // 自适应容器高度：类别多/文件多时伸展，防止标签重叠（CSS 里的 490 只是下限）
  var layout = null, hh = _VIZ_TUNE.batchMin;
  if(_vizData.view === 'batch'){
    hh = Math.max(_VIZ_TUNE.batchMin,
                  _VIZ_TUNE.batchBase + (_vizData.items || []).length * _VIZ_TUNE.batchStep);
  }else if(_vizData.view === 'frames'){
    // 自适应：按峰值目标数伸缩——峰值小别太高（线条显得陡），峰值大别太矮
    var _mx = 1, _fr = _vizData.frames || [];
    for(var _i = 0; _i < _fr.length; _i++){
      var _l = (_fr[_i] || []).length;
      if(_l > _mx) _mx = _l;
    }
    hh = Math.max(_VIZ_TUNE.framesMin,
                  Math.min(_VIZ_TUNE.framesMax,
                           _VIZ_TUNE.framesBase + _mx * _VIZ_TUNE.framesStep));
  }else{
    layout = _vizClassLayout();
    hh = layout.h;
  }
  if(host.style.height !== hh + 'px'){ host.style.height = hh + 'px'; }
  // 本批次/帧级趋势：图表 → 底部说明文字的间距独立可控。
  // 仅覆盖当前卡片的 --viz-cap-gap（类别分布移除覆盖、回落到 CSS 里的值，互不影响）。
  // 注意：真正的"大头"是说明文字的 margin + 空类别清单的 margin + 卡片底 padding，
  // 只改 host 的 margin 看不出效果，所以必须覆盖 --viz-cap-gap 并隐藏空清单。
  if(_vizData.view === 'class'){
    host.style.marginBottom = '';
    card.style.removeProperty('--viz-cap-gap');
  }else{
    host.style.marginBottom = '';
    card.style.setProperty('--viz-cap-gap', _VIZ_TUNE.subCapGap + 'px');
  }
  var opt;
  if(_vizData.view === 'batch') opt = _vizOptBatch();
  else if(_vizData.view === 'frames') opt = _vizOptFrames();
  else opt = _vizOptClass(vizAggregate(_vizData.cur.boxes, _vizData.cur.stats), layout);
  if(!host.offsetWidth){ setTimeout(_vizRender, 150); return; }   // 刚 show，等一帧布局
  // 等待入场动画期间先铺骨架屏（坐标轴/环形/幽灵柱），避免画布区大片空白“闪现”
  _showChartSkeleton(host, _vizData.view);
  // 构建待渲染包（类别视图需提前算图例数据；列表只在 _vizOptClass 内部才算出，此处先算一次）
  var p = {host: host, opt: opt, card: card, view: _vizData.view, legendList: null, legendTotal: 0};
  if(_vizData.view === 'class'){
    p.legendList = vizAggregate(_vizData.cur.boxes, _vizData.cur.stats);
    p.legendTotal = p.legendList.reduce(function(s, x){ return s + x.count; }, 0);
  }
  // 懒渲染：检测完成时图表可能位于屏幕下方（需滚动才看得到）。若立即渲染，入场动画会在用户
  // 看不见的地方播完、滚下去已错过。故——图表未暴露足够比例时先挂起，等滚动暴露到 ≥20%
  // 再真正渲染播放入场动画；已暴露则立即播放。
  // 切到别的卡片/视图时，旧的挂起包作废（避免隐藏卡片的渲染抢走 _vizChart 实例）。
  if(_vizPending && _vizPending.host !== host){
    if(_vizIO){ try{ _vizIO.unobserve(_vizPending.host); }catch(e){} }
    _vizPending = null;
  }
  if(_vizIsExposed(host)){
    if(_vizPending && _vizPending.host === host){   // 取消同 host 的旧挂起
      if(_vizIO){ try{ _vizIO.unobserve(host); }catch(e){} }
      _vizPending = null;
    }
    _vizDoRender(p);
  }else{
    _vizPending = p;
    var io = _vizEnsureIO();
    if(io){ io.observe(host); }
    else { _vizDoRender(p); }   // 浏览器不支持 IntersectionObserver 时直接渲染兜底
  }
}

// 环形图下方类别清单（HTML 三列网格，严格对齐；颜色与扇区同源，按占比降序）
function _vizRenderLegend(card, list, total){
  var box = card ? card.querySelector('.viz-legend') : null;
  if(!box) return;
  if(!list || !list.length || !total){ box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = 'grid';
  var html = list.slice(0, _VIZ_PIE_MAX).map(function(x, i){
    var pct = (x.count / total * 100).toFixed(2);   // 与环形 {d}%（默认 2 位小数）统一精度
    return '<div class="viz-lg-item" style="--lg-i:' + i + '">'+
      '<span class="viz-lg-dot" style="background:' + x.color + '"></span>'+
      '<span class="viz-lg-txt">' + x.name + ' <b>' + x.count + '</b>（' + pct + '%）</span>'+
      '</div>';
  }).join('');
  if(list.length > _VIZ_PIE_MAX){
    html += '<div class="viz-lg-more">另有 ' + (list.length - _VIZ_PIE_MAX) +
            ' 个类别占比更小，悬停环形图扇区可查看</div>';
  }
  box.innerHTML = html;
}
// —— 图表等待阶段「骨架屏」 ——
// 真实入场动画播放前，先在画布区铺一层静态骨架（坐标轴 + 环形/幽灵柱/面积 + 微光），
// 让用户知道“图表区域已就绪、正在准备数据”。图表真正 echarts.init 前由 _clearChartSkeleton 移除，
// 不干扰“重建实例播放入场动画”的铁律。
function _vizSkeletonHTML(view){
  var ring = '', bars = '', hbars = '', area = '';
  var i;
  if(view === 'class'){
    ring = '<div class="sk-ring"></div>';
    var hs = [38, 62, 50, 74, 44, 66, 54, 80];
    for(i = 0; i < hs.length; i++){ bars += '<div class="sk-bar" style="height:' + hs[i] + '%"></div>'; }
    bars = '<div class="sk-bars">' + bars + '</div>';
  }else if(view === 'batch'){
    var ws = [92, 78, 85, 64, 70, 80];
    for(i = 0; i < ws.length; i++){ hbars += '<div class="sk-hbar" style="width:' + ws[i] + '%"></div>'; }
    hbars = '<div class="sk-hbars">' + hbars + '</div>';
  }else if(view === 'frames'){
    area = '<div class="sk-area"></div>';
  }
  return ring + bars + hbars + area +
    '<div class="sk-axis-y"></div><div class="sk-axis-x"></div>' +
    '<div class="sk-shimmer"></div>';
}
function _showChartSkeleton(host, view){
  if(!host) return;
  if(getComputedStyle(host).position === 'static') host.style.position = 'relative';
  var ex = host.querySelector('.viz-skeleton');
  if(ex) ex.parentNode.removeChild(ex);
  var sk = document.createElement('div');
  sk.className = 'viz-skeleton';
  sk.innerHTML = _vizSkeletonHTML(view);
  host.appendChild(sk);
}
function _clearChartSkeleton(host){
  if(!host) return;
  var ex = host.querySelector('.viz-skeleton');
  if(ex) ex.parentNode.removeChild(ex);
}


// ===== 左侧「检测结果可视化」占位卡 =====
// 需求：检测完成后，左侧按钮下方的空白用一幅与当前模式匹配的示意图填充，
// 随结果一起出现；「清除当前检测」或无结果时恢复隐藏。纯装饰，不参与任何逻辑。
// 出现时机按模式区分：
//   单图 / 批量图 / 单视频 / 批量视频 → 右侧结果区渲染完成（state._dvReady 置位）
var _DV_CONF = {
  'image':       {cap:'<b>图片检测完成</b> · 结果已在右侧展示'},
  'batch-image': {cap:'<b>批量图片检测完成</b> · 已逐张归档，右侧可翻页查看'},
  'video':       {cap:'<b>视频检测完成</b> · 标注视频已在右侧循环播放'},
  'batch-video': {cap:'<b>批量视频检测完成</b> · 结果已在右侧展示，可翻页查看'}
};
// 可视化卡骨架：标题 + 视图切换 + 图表容器 + 空态 + 底部说明
function _vizShell(){
  return '<div class="viz-head">'+
    '<div class="viz-title">检测结果可视化</div>'+
    '<div class="viz-switch">'+
      '<button class="viz-btn active" data-view="class" onclick="switchDetectChart(\'class\')">类别分布</button>'+
      '<button class="viz-btn" data-view="batch" onclick="switchDetectChart(\'batch\')">本批次</button>'+
      '<button class="viz-btn" data-view="frames" onclick="switchDetectChart(\'frames\')">帧级趋势</button>'+
    '</div></div>'+
    '<div class="viz-chart-host"></div>'+
    '<div class="viz-legend"></div>'+
    '<div class="viz-empty">暂无可视化数据，检测完成后自动展示</div>'+
    '<div class="viz-cap"></div>';
}
function _vizActiveCard(){
  var panel = document.querySelector('.source-panel.active');
  return panel ? panel.querySelector('.detect-visual') : null;
}
// 同步四块可视化卡的显隐：只在「当前激活面板」且该模式已有结果时显示；
// 显隐就绪后挂载/刷新其中的 ECharts 图表
function syncDetectVisual(){
  var active=document.querySelector('.source-panel.active');
  var cur=active?active.id.replace('src-',''):'';
  ['image','batch-image','video','batch-video'].forEach(function(m){
    var panel=document.getElementById('src-'+m);
    var el=panel?panel.querySelector('.detect-visual'):null;
    if(!el) return;
    var show=(m===cur) && !!state._dvReady;
    if(show){
      if(el.getAttribute('data-filled')!=='1'){
        el.innerHTML=_vizShell();
        el.setAttribute('data-filled','1');
      }
      var cap=el.querySelector('.viz-cap');
      if(cap) cap.innerHTML=_DV_CONF[m].cap;
      el.classList.add('show');
    }else{
      el.classList.remove('show');
    }
  });
  if(state._dvReady) _vizRender();
}

// ===== 清除当前检测 =====
function clearDetect(){
  if(state.webcamStream){ stopWebcam(); }
  if(state.streamActive){ stopStream(); }
  // P1-3：若正在跑批量任务，一并中止并收尾
  if(_batchAbort){ state.batchAborted = true; _batchAbort.abort(); }
  endTask();
  showCancelBtn(false);
  _batchFinish = null;
  state.selectedImageFile = null;
  state.selectedVideoFile = null;
  state.batchImageFiles = [];
  state.batchVideoFiles = [];
  state.batchItems = [];
  state.batchIdx = 0;
  // 重置文件选择控件
  var f1 = document.getElementById('detect-file'); if(f1) f1.value='';
  var f2 = document.getElementById('detect-video-file'); if(f2) f2.value='';
  var f3 = document.getElementById('batch-image-file'); if(f3) f3.value='';
  var f4 = document.getElementById('batch-video-file'); if(f4) f4.value='';
  // 重置提示文字
  var t1 = document.getElementById('image-dropzone-text');
  if(t1) t1.innerHTML = '拖拽图片到这里，或 <span class="hl">点击选择文件</span>';
  var t2 = document.getElementById('video-dropzone-text');
  if(t2) t2.innerHTML = '拖拽视频到这里，或 <span class="hl">点击选择文件</span>';
  var t3 = document.getElementById('batch-image-text');
  if(t3) t3.innerHTML = '拖拽多张图片到这里，或 <span class="hl">点击选择文件（可按 Ctrl 多选）</span>';
  var t4 = document.getElementById('batch-video-text');
  if(t4) t4.innerHTML = '拖拽多个视频到这里，或 <span class="hl">点击选择文件（可按 Ctrl 多选）</span>';
  // 重置文件列表/队列
  var bl = document.getElementById('batch-image-list');
  if(bl) bl.innerHTML = '<div style="color:var(--text-2);font-size:13px;padding:8px 0">尚未选择文件</div>';
  var bq = document.getElementById('batch-video-queue');
  if(bq) bq.innerHTML = '<div style="color:var(--text-2);font-size:13px;padding:8px 0">尚未选择视频</div>';
  // 重置单图/单视频的「尚未选择」提示区
  setImageFileHint(null);
  setVideoFileHint(null);
  // 重置结果区
  document.getElementById('detect-empty').style.display='flex';
  document.getElementById('detect-result').style.display='none';
  document.getElementById('video-result').style.display='none';
  document.getElementById('batch-nav').style.display='none';
  vizReset();   // 图表销毁 + 空态
  state.videoResultActive = false;   // 停掉视频结果页的逐帧画框循环
  // 收起左侧模式占位图（结果区已清空）
  state._dvReady = false;
  syncDetectVisual();
  toast('已清空当前检测');
}

function switchSource(src){
  document.querySelectorAll('.source-tab').forEach(function(t){
    t.classList.toggle('active', t.getAttribute('data-src')===src);
  });
  document.querySelectorAll('.source-panel').forEach(function(p){
    p.classList.toggle('active', p.id==='src-'+src);
  });
  var g=document.getElementById('detect-grid');
  if(src!=='webcam' && state.webcamStream){ stopWebcam(); }
  if(src!=='stream' && state.streamActive){ stopStream(); }
  if(g) g.classList.toggle('live-mode', src==='webcam' || src==='stream');
  // 切换上传模式：占位图跟随当前激活面板（有结果才显示）
  if(src==='image'||src==='batch-image'||src==='video'||src==='batch-video'){ syncDetectVisual(); }
}
// ===== 实时摄像头检测 =====
state.webcamStream = null;
state.webcamTimer = null;
state.webcamBusy = false;
state.webcamActive = false;   // 链式取帧调度开关（替代固定 setInterval）
state.webcamCanvas = document.createElement('canvas');

function populateWebcamDevices(stream){
  return navigator.mediaDevices.enumerateDevices().then(function(devices){
    var cams = devices.filter(function(d){return d.kind==='videoinput';});
    var sel = document.getElementById('webcam-device');
    if(!sel) return cams;
    var cur = sel.value;
    sel.innerHTML = '';
    if(!cams.length){
      sel.innerHTML = '<option value="">默认摄像头</option>';
      return cams;
    }
    cams.forEach(function(d, i){
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || ('摄像头 '+(i+1));
      sel.appendChild(opt);
    });
    // 选中当前正在使用的设备
    if(stream){
      var track = stream.getVideoTracks && stream.getVideoTracks()[0];
      var settings = track && track.getSettings && track.getSettings();
      if(settings && settings.deviceId) sel.value = settings.deviceId;
    } else if(cur){
      sel.value = cur;
    }
    return cams;
  }).catch(function(){ return []; });
}

function onWebcamDeviceChange(){
  // 摄像头运行中切换设备：重启
  if(state.webcamStream){ startWebcam(); }
}

function startWebcam(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast('当前浏览器不支持摄像头调用（需 HTTPS 或 localhost）');
    return;
  }
  if(state.webcamStream){ stopWebcam(); }
  var devId = (document.getElementById('webcam-device')||{}).value || '';
  var videoConstraints = devId
    ? {deviceId:{exact:devId}, width:{ideal:3840}, height:{ideal:2160}}
    : {facingMode:'environment', width:{ideal:3840}, height:{ideal:2160}};
  navigator.mediaDevices.getUserMedia({video:videoConstraints, audio:false})
    .then(function(stream){
      state.webcamStream = stream;
      var sb=document.getElementById('webcam-stop-btn'); if(sb) sb.style.display='';
      populateWebcamDevices(stream);
      var video = document.getElementById('webcam-video');
      var img = document.getElementById('webcam-canvas');
      video.srcObject = stream;
      video.style.display = 'block';
      img.style.display = 'none';
      // 记录源分辨率（与工控页口径一致：显示"源 W×H · 上传 640×H"）
      video.onloadedmetadata = function(){
        state.webcamSrcW = video.videoWidth; state.webcamSrcH = video.videoHeight;
      };
      document.getElementById('webcam-placeholder').style.display = 'none';
      document.getElementById('webcam-frame').classList.add('live');
      document.getElementById('webcam-stats').style.display = 'block';
      video.play().then(function(){
        state.webcamActive = true;
        captureWebcamFrame();   // 链式触发：每帧推理完立即请求下一帧，逼近后端极限帧率（与工控页一致）
      });
      toast('摄像头已开启，实时推理中');
    })
    .catch(function(err){
      console.error(err);
      toast('无法访问摄像头：' + (err.message || '权限被拒绝'));
    });
}

function captureWebcamFrame(){
  if(!state.webcamActive || !state.webcamStream) return;
  if(state.webcamBusy){
    // 上一帧仍在处理：稍后重试，不断链（不丢弃）
    state.webcamTimer = setTimeout(captureWebcamFrame, 50);
    return;
  }
  var video = document.getElementById('webcam-video');
  if(!video || video.readyState < 2){
    state.webcamTimer = setTimeout(captureWebcamFrame, 100);
    return;
  }
  // 缩放到 640 宽，降低传输与推理压力
  var w = video.videoWidth, h = video.videoHeight;
  if(!w || !h){
    state.webcamTimer = setTimeout(captureWebcamFrame, 100);
    return;
  }
  var targetW = 640, scale = targetW / w, targetH = Math.round(h * scale);
  var canvas = state.webcamCanvas;
  canvas.width = targetW; canvas.height = targetH;
  canvas.getContext('2d').drawImage(video, 0, 0, targetW, targetH);
  canvas.toBlob(function(blob){
    if(!blob){
      // toBlob 失败：稍后重试，不断链
      state.webcamTimer = setTimeout(captureWebcamFrame, 100);
      return;
    }
    state.webcamBusy = true;
    state.webcamCaptureTs = performance.now();   // 记录抓帧时刻，用于框的平滑时长（与工控页一致）
    var fd = new FormData();
    fd.append('frame', blob, 'frame.jpg');
    fd.append('conf', readConfValue('webcam-conf-value'));
    // 与工控页一致：不要后端标注图（那只有 640 宽），底层视频保持原生分辨率播放
    fd.append('want_frame', '0');
    fetch(API + '/api/detect/frame', {method:'POST', body:fd, credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!state.webcamActive || !state.webcamStream) return;  // 已停止，丢弃在途帧
        if(d.ok){
          // 画面仍用原生视频（最高清），检测框用 canvas 叠加绘制
          var vEl = document.getElementById('webcam-video');
          if(vEl) vEl.style.display = 'block';
          // 与工控页**同一套**平滑动画（插值 + 阻尼外推），框不再一跳一跳
          boxAnimUpdate('webcam', d.boxes,
            state.webcamCaptureTs ? (performance.now() - state.webcamCaptureTs) : 120,
            targetW,
            function(){ return state.webcamActive && !!state.webcamStream; },
            function(list){
              if(list === null){ webcamClearBoxes(); return; }
              webcamDrawBoxes(list, targetW, targetH);
            });
          // 真实端到端 FPS（与工控页同一口径）：每帧算瞬时帧率做指数滑动平均，
          // 不再用"1000÷推理耗时"（那只是后端耗时反推，虚高且不含抓帧/上传/渲染）
          var _now = performance.now();
          if(state.webcamFpsPrevTs){
            var _dt = _now - state.webcamFpsPrevTs;
            if(_dt > 0){
              var _inst = 1000 / _dt;
              state.webcamFpsEma = state.webcamFpsEma ? (state.webcamFpsEma * 0.75 + _inst * 0.25) : _inst;
            }
          }
          state.webcamFpsPrevTs = _now;
          renderWebcamStatsThrottled(d.stats, d.total, d.duration_ms);
        } else if(d.msg){
          toast(d.msg);
        }
      })
      .catch(function(){})
      .finally(function(){
        state.webcamBusy = false;
        // 链式触发下一帧：上一帧结束后立即请求，最大化帧率（与工控页一致）
        if(state.webcamActive && state.webcamStream){
          state.webcamTimer = setTimeout(captureWebcamFrame, 0);
        }
      });
  }, 'image/jpeg', 0.95);   // q0.7→0.95：与工控页一致，减少 JPEG 伪影对贴阈值目标的干扰
}

// 检测页摄像头：把检测框画到叠加 canvas 上（底层视频保持原生分辨率）。
// boxes 坐标是上传帧（640×targetH）空间，这里换算到画面实际显示区域（object-fit:contain）。
function webcamDrawBoxes(boxes, fw, fh){
  var cv = document.getElementById('webcam-box-canvas');
  var frameEl = document.getElementById('webcam-frame');
  if(!cv || !frameEl) return;
  var bw = frameEl.clientWidth, bh = frameEl.clientHeight;
  if(!bw || !bh || !fw || !fh){ return; }
  var sc = Math.min(bw / fw, bh / fh);          // 与 video 的 object-fit:contain 对齐
  var ox = (bw - fw * sc) / 2, oy = (bh - fh * sc) / 2;
  var dpr = window.devicePixelRatio || 1;
  var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
  if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, bw, bh);
  cv.style.display = 'block';
  if(!boxes || !boxes.length) return;
  g.lineWidth = 2;
  g.font = '600 12px system-ui, "Microsoft YaHei", sans-serif';
  for(var i = 0; i < boxes.length; i++){
    var b = boxes[i];
    var x1 = b.x1 * sc + ox, y1 = b.y1 * sc + oy;
    var x2 = b.x2 * sc + ox, y2 = b.y2 * sc + oy;
    var col = _boxColor(b);        // 按类别取色（与工控页、后端原生标注同款配色）
    g.fillStyle = _boxFill(col, .16);
    g.fillRect(x1, y1, x2 - x1, y2 - y1);
    g.strokeStyle = col;
    g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    var label = b.cls_name + ' ' + Math.round((b.conf || 0) * 100) + '%';
    var tw = g.measureText(label).width;
    var ly = Math.max(0, y1 - 15);
    g.fillStyle = _boxFill(col, .92);
    g.fillRect(x1, ly, tw + 8, 15);
    g.fillStyle = '#ffffff';       // 白字：类别色深浅不一，深色字在深蓝/紫上会看不清
    g.fillText(label, x1 + 4, ly + 11);
  }
}

function webcamClearBoxes(){
  var cv = document.getElementById('webcam-box-canvas');
  if(!cv) return;
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  cv.style.display = 'none';
}

// 与工控页同理：每帧重建卡片 DOM 太贵，按内容变化 + 200ms 节流
function renderWebcamStatsThrottled(stats, total, ms){
  var key = JSON.stringify(stats) + '|' + total + '|' + ms;
  var now = performance.now();
  if(key === state.webcamStatsKey && (now - (state.webcamStatsTs || 0)) < 200) return;
  state.webcamStatsKey = key; state.webcamStatsTs = now;
  renderWebcamStats(stats, total, ms);
}

function renderWebcamStats(stats, total, ms){
  var sw = document.getElementById('webcam-stats');
  var chips = [];
  for(var k in stats){
    chips.push('<span style="display:inline-block;padding:4px 12px;margin:0 6px 6px 0;border-radius:14px;background:rgba(201,152,107,.12);color:var(--accent);font-size:13px">'+k+'：'+stats[k]+'</span>');
  }
  // FPS 用真实端到端帧率（工控页同口径），ms 仍是后端单帧推理耗时
  var fps = state.webcamFpsEma ? state.webcamFpsEma.toFixed(1) : (ms ? (1000/ms).toFixed(1) : '—');
  // 分辨率：源画面分辨率（摄像头原始）+ 上传推理分辨率（固定 640 宽，与工控页一致）
  var resTxt = '';
  if(state.webcamSrcW && state.webcamSrcH){
    resTxt = ' · 源 ' + state.webcamSrcW + '×' + state.webcamSrcH + ' · 上传 640×' +
             Math.round(state.webcamSrcH * 640 / state.webcamSrcW);
  }
  sw.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap">'+
      '<span style="font-size:13px;color:var(--text-3)">实时统计（总目标 <b style="color:var(--accent)">'+(total||0)+'</b>）</span>'+
      '<span style="font-size:12px;color:var(--text-3)">单帧 '+ms+'ms · FPS '+fps+resTxt+'</span>'+
    '</div>' + (chips.join('') || '<span style="color:var(--text-3);font-size:13px">未检测到目标</span>');
}

function stopWebcam(silent){
  state.webcamActive = false;   // 先关开关，打断链式取帧
  state.webcamFpsEma = null; state.webcamFpsPrevTs = 0;   // 重置 FPS 滑动平均
  if(state.webcamTimer){ clearTimeout(state.webcamTimer); state.webcamTimer = null; }
  if(state.webcamStream){ state.webcamStream.getTracks().forEach(function(t){t.stop();}); state.webcamStream = null; }
  var video = document.getElementById('webcam-video');
  var img = document.getElementById('webcam-canvas');
  if(video){ video.pause(); video.srcObject = null; video.removeAttribute('src'); try{video.load();}catch(e){} video.style.display='none'; }
  if(img){ img.removeAttribute('src'); img.src=''; img.style.display='none'; }
  boxAnimStop('webcam', webcamClearBoxes);   // 停掉框动画并清掉叠加的检测框
  var f = document.getElementById('webcam-frame');
  f.classList.remove('live');
  var ph = document.getElementById('webcam-placeholder');
  ph.style.display = '';
  ph.textContent = '摄像头未开启，点击下方按钮启动';
  document.getElementById('webcam-stats').style.display = 'none';
  var sb2=document.getElementById('webcam-stop-btn'); if(sb2) sb2.style.display='none';
  if(!silent) toast('已断开摄像头');
}

// ===== 网络流（RTSP/RTMP/HTTP）实时检测 =====
state.streamActive = false;
state.streamSid = null;
state.streamClsMap = {};   // 类别名→cls_id 映射：播放完成后图表据此与流框同色
state.streamTimer = null;
function setStreamLiveBadge(live){
  var b = document.getElementById('stream-live-badge');
  if(!b) return;
  if(live){ b.classList.remove('ended'); b.textContent = '● LIVE'; }
  else { b.classList.add('ended'); b.textContent = '● 已结束'; }
}
function startStream(){
  var url = (document.getElementById('stream-url').value || '').trim();
  if(!url){ toast('请输入视频流地址'); return; }
  var img = document.getElementById('stream-img');
  document.getElementById('stream-placeholder').style.display = 'none';
  document.getElementById('stream-frame').classList.add('live');
  img.style.display = 'block';
  state.streamActive = true;
  state.streamSid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  state.streamErrShown = false;
  state.streamClsMap = {};   // 类别名→cls_id 映射（播放完成后图表据此与流框同色）
  // 重置上一轮流的图表：清守卫 + 销毁实例 + 隐藏卡片，避免残留或串台到新一轮
  _streamRenderedSid = null;
  if(_streamChart){ try{ _streamChart.dispose(); }catch(e){} _streamChart = null; }
  _streamPending = null;
  if(_streamIO){ try{ _streamIO.disconnect(); }catch(e){} }
  var sc0 = document.getElementById('stream-chart-card'); if(sc0){ sc0.style.display='none'; sc0.classList.remove('show'); }
  setStreamLiveBadge(true);
  var db=document.getElementById('stream-stop-btn'); if(db) db.style.display='';
  var sw=document.getElementById('stream-stats'); if(sw){ sw.style.display='block'; sw.innerHTML=''; }
  showLoading('正在连接视频流并启动推理...');
  img.onload = function(){ hideLoading(); };
  img.onerror = function(){
    hideLoading();
    if(!state.streamActive) return;
    toast('视频流连接失败，请检查地址或网络');
  };
  // 同源 img 自动带登录 cookie；sid 用于取回结构化统计
  img.src = API + '/api/detect/stream?url=' + encodeURIComponent(url) + '&sid=' + state.streamSid
    + '&conf=' + encodeURIComponent(readConfValue('stream-conf-value'));
  if(state.streamTimer) clearInterval(state.streamTimer);
  state.streamTimer = setInterval(pollStreamStats, 500);
  // 前端画框：高频轮询最新一帧的框，交给通用平滑动画（与工控页同一套），贴合原始 MJPEG
  if(state.streamBoxTimer) clearInterval(state.streamBoxTimer);
  state.streamBoxTimer = setInterval(pollStreamBoxes, 120);
  toast('正在连接视频流并启动推理...');
}
function pollStreamStats(){
  if(!state.streamActive || !state.streamSid) return;
  fetch(API + '/api/detect/stream/stats?sid=' + state.streamSid, {credentials:'same-origin'})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d && d.error){
        if(!state.streamErrShown){ state.streamErrShown = true; toast(d.error); }
        return;
      }
      if(d && d.ended){
        if(!state.streamErrShown){ state.streamErrShown = true; toast('视频播放结束'); }
        setStreamLiveBadge(false);
        if(d.stats) renderStreamStats(d.stats, d.total, d.dur_ms || 0, true, d);
        if(d.stats) _renderStreamChart(_streamBuildList(d.stats, d.conf_sum, state.streamClsMap), state.streamSid);
        return;
      }
      if(d && d.active){
        renderStreamStats(d.stats, d.total, d.duration_ms);
      }
    })
    .catch(function(){});
}
function renderStreamStats(stats, total, ms, ended, d){
  var sw = document.getElementById('stream-stats');
  if(!sw) return;
  var chips = [];
  for(var k in stats){
    chips.push('<span style="display:inline-block;padding:4px 12px;margin:0 6px 6px 0;border-radius:14px;background:rgba(201,152,107,.12);color:var(--accent);font-size:13px">'+k+'：'+stats[k]+'</span>');
  }
  // 分辨率：与工控页口径一致，显示码流原始分辨率（该模式是服务端推理，画面即原始分辨率）
  var resTxt = '';
  var sImg = document.getElementById('stream-img');
  if(sImg && sImg.naturalWidth){
    resTxt = ' · 源 ' + sImg.naturalWidth + '×' + sImg.naturalHeight;
  }
  var right;
  if(ended){
    right = '<span style="font-size:12px;color:var(--text-3)">视频已结束' + resTxt + '</span>';
  } else {
    var fps = ms ? (1000/ms).toFixed(1) : '—';
    right = '<span style="font-size:12px;color:var(--text-3)">单帧 '+ms+'ms · 约 '+fps+' fps'+resTxt+'</span>';
  }
  // 播放完成：与检测页/历史详情同一套摘要模板（buildDetectSummary）——
  // 共 F 帧（推理 I 帧）· 检测到 N 个目标 · M 个类别 · 耗时 X
  var title;
  if(ended){
    title = buildDetectSummary({
      stats: stats, duration_ms: ms || 0,
      total_frames: (d && d.frames) || 0, inferred_frames: (d && d.infer) || 0
    }, true);
  } else {
    title = '实时统计（总目标 <b style="color:var(--accent)">'+(total||0)+'</b>）';
  }
  sw.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'+
      '<span style="font-size:13px;color:' + (ended ? 'var(--text-1)' : 'var(--text-3)') + '">'+title+'</span>'+
      right+
    '</div>' + (chips.join('') || '<span style="color:var(--text-3);font-size:13px">未检测到目标</span>');
}
// ===================== 网络流播放完成后的 ECharts 统计图表 =====================
// 仅“播放完成(ended)”后追加展示，与检测页类别分布图同一套渲染（_vizOptClass）：
// 柱=数量 / 折线=平均置信度 / 环=占比；并复用检测页的动画与懒加载规则
// （重建实例播放入场动画、setOption 后不立即 resize、暴露≥20% 才真正渲染）。
var _streamChart = null;
var _streamPending = null;
var _streamIO = null;
var _streamRenderedSid = null;   // 已为哪个 sid 渲染过图表：防止 ended 后每 500ms 轮询重复重建→反复播动画/刷新
function _streamBuildList(stats, confSum, clsMap){
  var names = Object.keys(stats || {});
  var list = names.map(function(n, i){
    var cnt = stats[n] || 0;
    var avg = (confSum && confSum[n] && cnt) ? (confSum[n] / cnt) : 0;
    // 用累积到的 cls_id 着色（与流框、检测页一致）；无 cls 时按名字哈希兜底
    var cid = (clsMap && clsMap[n] != null) ? clsMap[n] : undefined;
    return {name:n, count:cnt, avg:avg, color:_catColor(n, cid)};
  });
  list = list.filter(function(x){ return x.count > 0; });   // 去掉 0 计数的幽灵类别
  list.sort(function(a, b){ return b.count - a.count; });
  return list;
}
function _streamEnsureIO(){
  if(_streamIO || typeof IntersectionObserver === 'undefined') return _streamIO;
  _streamIO = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting && e.intersectionRatio >= 0.2){
        if(_streamPending && e.target === _streamPending.host){
          var p = _streamPending; _streamPending = null;
          try{ _streamIO.unobserve(p.host); }catch(err){}
          _doStreamRender(p);
        }
      }
    });
  }, {threshold:[0,0.2,1]});
  return _streamIO;
}
function _doStreamRender(p){
  var host = p.host;
  if(typeof echarts === 'undefined') return;
  _clearChartSkeleton(host);   // 真正渲染时移除骨架屏，露出入场动画
  if(_streamChart){ try{ _streamChart.dispose(); }catch(e){} _streamChart = null; }  // 重建实例，强制重播入场动画
  var cv = host.querySelector('.viz-cv');
  if(!cv){
    cv = document.createElement('div'); cv.className = 'viz-cv';
    cv.style.width = '100%'; cv.style.height = '100%';
    host.appendChild(cv);
  }
  _streamChart = echarts.init(cv);
  _streamChart.setOption(p.opt, true);
  _streamRenderedSid = p.sid;   // 标记本 sid 已渲染，后续同 sid 轮询不再重建
  // 注意：setOption 后绝不能紧接着 resize()，否则打断几何入场动画（柱/饼闪现）
  if(p.view === 'class'){ _vizRenderLegend(p.card, p.legendList, p.legendTotal); }
}
function _renderStreamChart(list, sid){
  var card = document.getElementById('stream-chart-card');
  var host = card ? card.querySelector('.viz-chart-host') : null;
  if(!card || !host) return;
  var total = list.reduce(function(s, x){ return s + x.count; }, 0);
  if(!total){ card.style.display = 'none'; return; }
  card.classList.add('show');
  card.style.display = 'block';
  // 已为该 sid 渲染过（图表实例仍存活）→ 不再重建，避免 ended 后每 500ms 轮询重复触发入场动画而反复播放/刷新
  if(_streamRenderedSid === sid && _streamChart){ return; }
  // 等待懒渲染（滚动暴露）期间先铺骨架屏，避免画布区空白“闪现”
  _showChartSkeleton(host, 'class');
  var layout = _vizClassLayout();
  var opt = _vizOptClass(list, layout);
  var p = {host:host, opt:opt, card:card, view:'class', legendList:list, legendTotal:total, sid:sid};
  // 懒渲染：图表在页面下方，未暴露足够比例（≥20%）时先挂起，滚动到位再播放入场动画
  if(_streamPending && _streamPending.host !== host){
    if(_streamIO){ try{ _streamIO.unobserve(_streamPending.host); }catch(e){} }
    _streamPending = null;
  }
  if(_vizIsExposed(host)){
    if(_streamPending && _streamPending.host === host){
      if(_streamIO){ try{ _streamIO.unobserve(host); }catch(e){} }
      _streamPending = null;
    }
    _doStreamRender(p);
  }else{
    _streamPending = p;
    var io = _streamEnsureIO();
    if(io){ io.observe(host); } else { _doStreamRender(p); }   // 不支持 IntersectionObserver 时直接渲染兜底
  }
}
// 高频拉取最新一帧框（与底层原始 MJPEG 对齐），交给通用平滑动画叠加到 canvas
function pollStreamBoxes(){
  if(!state.streamActive || !state.streamSid) return;
  fetch(API + '/api/detect/stream/boxes?sid=' + state.streamSid, {credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!state.streamActive) return;
      if(!d || !d.ok){ return; }
      state.streamFrameW = d.frame_w || 0;
      state.streamFrameH = d.frame_h || 0;
      // 累积「类别名→cls_id」映射：播放完成后图表据此与流框同色（流统计仅返回 name→count，无 cls）
      (d.boxes || []).forEach(function(b){
        if(b && b.cls_name != null && state.streamClsMap[b.cls_name] == null && typeof b.cls === 'number'){
          state.streamClsMap[b.cls_name] = b.cls;
        }
      });
      var cv = document.getElementById('stream-box-canvas');
      if(!d.live){
        // 流已结束/出错：清掉残留的框（底层 MJPEG 此时是结束提示帧，不再有目标）
        boxAnimStop('stream', null);
        if(cv) cv.style.display = 'none';
        return;
      }
      if(cv && d.boxes && d.boxes.length) cv.style.display = 'block';
      // 复用与工控页/摄像头同一套平滑动画：框在两次轮询之间做插值 + 阻尼外推，观感流畅
      boxAnimUpdate('stream', d.boxes || [], 150, (d.frame_w || 640),
        function(){ return state.streamActive; },
        function(list){ streamDrawBoxes(list); });
    })
    .catch(function(){});
}
// 把平滑后的框画到 stream 的叠加 canvas（底层 img 为原始 MJPEG，按 object-fit:contain 对齐）
function streamDrawBoxes(list){
  var cv = document.getElementById('stream-box-canvas');
  var img = document.getElementById('stream-img');
  if(!cv || !img) return;
  var bw = img.clientWidth, bh = img.clientHeight;
  var fw = state.streamFrameW || img.naturalWidth, fh = state.streamFrameH || img.naturalHeight;
  if(!bw || !bh || !fw || !fh){
    if(!list){ cv.style.display = 'none'; }
    return;
  }
  var sc = Math.min(bw / fw, bh / fh);
  var ox = (bw - fw * sc) / 2, oy = (bh - fh * sc) / 2;
  var dpr = window.devicePixelRatio || 1;
  var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
  if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, bw, bh);
  if(!list){ cv.style.display = 'none'; return; }
  drawBoxesCore(g, list, sc, 2, 12, 1, ox, oy);
}
function stopStream(silent){
  state.streamActive = false;
  if(state.streamSid){
    // 通知后端立即清理该流统计缓存（keepalive 保证页面关闭也能发出）
    try{ fetch(API + '/api/detect/stream/stop?sid=' + state.streamSid, {credentials:'same-origin', keepalive:true}); }catch(e){}
  }
  state.streamSid = null;
  state.streamClsMap = {};   // 清掉上一轮流的类别映射，避免串台到新一轮
  if(state.streamTimer){ clearInterval(state.streamTimer); state.streamTimer = null; }
  if(state.streamBoxTimer){ clearInterval(state.streamBoxTimer); state.streamBoxTimer = null; }
  boxAnimStop('stream', null);   // 停掉框平滑动画并清掉叠加的检测框
  var sbc = document.getElementById('stream-box-canvas'); if(sbc) sbc.style.display = 'none';
  var db2=document.getElementById('stream-stop-btn'); if(db2) db2.style.display='none';
  var img = document.getElementById('stream-img');
  if(img){ img.onload=null; img.onerror=null; img.removeAttribute('src'); img.src=''; img.style.display='none'; }
  setStreamLiveBadge(true);
  var sw = document.getElementById('stream-stats'); if(sw){ sw.style.display='none'; sw.innerHTML=''; }
  // 清理播放完成后的图表（与上方 stream-stats 一起清掉，避免残留上一轮）
  var sc = document.getElementById('stream-chart-card'); if(sc){ sc.style.display='none'; sc.classList.remove('show'); }
  _streamRenderedSid = null;
  if(_streamChart){ try{ _streamChart.dispose(); }catch(e){} _streamChart = null; }
  _streamPending = null;
  if(_streamIO){ try{ _streamIO.disconnect(); }catch(e){} }
  var f = document.getElementById('stream-frame');
  f.classList.remove('live');
  var ph = document.getElementById('stream-placeholder');
  ph.style.display = '';
  ph.textContent = '尚未连接网络流';
  if(!silent) toast('已断开视频流');
}

// ===== 模型管理 =====
function loadModels(){
  api('/api/models').then(function(res){
    if(!res.data.ok){ toast(res.data.msg||'加载模型失败'); return; }
    state.models = res.data.models;
    renderModels();
  });
}
function refreshModelsMeta(){
  showLoading('正在重新读取所有模型元信息，请稍候...', 600);
  api('/api/models/refresh-meta', {method:'POST'})
    .then(function(res){
      hideLoading();
      if(!res.data.ok){ toast(res.data.msg||'刷新失败'); return; }
      var f = (res.data.failed||[]);
      toast('已更新 '+res.data.updated+' 个模型元信息'+(f.length?('，失败 '+f.length+' 个'):''));
      loadModels();
    })
    .catch(function(e){ hideLoading(); toast('刷新请求失败：'+e.message); });
}
function renderModels(){
  var MODELS = state.models;
  var grid=document.getElementById('model-grid');
  if(!grid) return;
  var kw = (document.getElementById('model-search')||{value:''}).value.trim().toLowerCase();
  if(kw){
    MODELS = MODELS.filter(function(m){
      var hay = ((m.name||'')+' '+(m.file_name||'')+' '+(m.note||'')+' '+
        (m.tags||[]).join(' ')).toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }
  grid.innerHTML='';
  if(!MODELS.length){
    // 发布包只预装 yolo26n.pt；客户删光权重时给明确空态，而不是一片空白
    var empty=document.createElement('div');
    empty.style.cssText='grid-column:1/-1;text-align:center;color:var(--text-3);padding:48px 0;font-size:13px';
    empty.textContent = kw
      ? ('没有匹配「'+kw+'」的模型')
      : 'models_lib 里还没有模型，请上传 .pt 权重后点击「刷新」';
    grid.appendChild(empty);
  }
  MODELS.forEach(function(m){
    var card=document.createElement('div');
    card.className='model-card'+(m.status==='current'?' active':'');
    var tagHtml;
    if(m.status==='current') tagHtml='<span class="mc-tag current">● 当前使用</span>';
    else if(m.status==='loaded') tagHtml='<span class="mc-tag ready">已加载</span>';
    else tagHtml='<span class="mc-tag unloaded">未加载</span>';
    var mapVal = m.map!=null ? m.map : '—';
    var paramsVal = m.params || '—';
    var tagCount = (m.tags && m.tags.length) ? m.tags.length : '—';
    card.innerHTML=
      (state.modelsEditing ? '<div style="margin-bottom:8px"><input type="checkbox" class="model-cb" value="'+m.id+'"'+(state.modelCheckedIds[m.id]?' checked':'')+' onchange="onModelCBClick('+m.id+', this.checked)"></div>' : '')+
      '<div class="mc-head"><div class="mc-name">'+m.name+'</div>'+tagHtml+'</div>'+
      '<div class="mc-desc">'+(m.desc||m.file_name)+'<br><span style="color:var(--text-3);font-size:11.5px">'+(m.note||'')+'</span></div>'+
      '<div class="mc-stats">'+
        '<div>mAP@0.5 <b>'+mapVal+'</b></div>'+
        '<div>参数量 <b>'+paramsVal+'</b></div>'+
        '<div>大小 <b>'+m.size+'</b></div>'+
        '<div>类别 <b>'+tagCount+' 类</b>'+
          (((m.classes && m.classes.length) || (m.tags && m.tags.length))
            ? '<span style="margin-left:6px;font-size:11px;color:var(--accent);cursor:pointer;text-decoration:underline" title="查看具体类别名" onclick="showModelClasses('+m.id+')">查看</span>'
            : '')+
        '</div>'+
      '</div>'+
      '<div class="mc-actions">'+
        (m.status==='current'
          ?'<button class="btn btn-ghost" disabled style="opacity:.5;cursor:not-allowed">当前模型</button>'
          :'<button class="btn btn-primary" onclick="useModel('+m.id+')">使用此模型</button>')+
        (m.status==='current'
          ?'<button class="btn btn-ghost" disabled style="opacity:.5;cursor:not-allowed" title="当前使用中的模型不可删除">删除</button>'
          :'<button class="btn btn-ghost" onclick="deleteModel('+m.id+')">删除</button>')+
        (m.status==='current'
          ?'<button class="btn btn-ghost" disabled style="opacity:.5;cursor:not-allowed" title="当前使用中的模型不可卸载">卸载</button>'
          :'<button class="btn btn-ghost" onclick="unloadModel('+m.id+')" title="从内存卸载，下次使用重新加载">卸载</button>')+
      '</div>';
    grid.appendChild(card);
  });
  document.getElementById('model-count').textContent=MODELS.length;
  if(typeof updateModelsCheckAllLabel === 'function') updateModelsCheckAllLabel();
  var cur=MODELS.find(function(m){return m.status==='current'});
  if(cur){
    document.getElementById('cur-model-name').textContent=cur.name;
    document.getElementById('cur-model-sub').textContent=cur.file_name;
    document.getElementById('cur-map').textContent = cur.map!=null ? cur.map : '—';
    document.getElementById('cur-params').textContent = cur.params || '—';
    document.getElementById('cur-size').textContent=cur.size;
  }
}
function useModel(id){
  var m=state.models.find(function(x){return x.id===id});
  if(!m) return;
  confirmDialog('切换模型','确定要切换到 <b style="color:var(--accent)">'+m.name+'</b> 吗？新模型加载可能需要几秒钟...', function(){
    showLoading('正在加载模型 '+m.name+' ...', 600);
    api('/api/models/switch', {method:'POST', body: JSON.stringify({file_name:m.file_name})})
      .then(function(res){
        hideLoading();
        if(res.data.ok){ toast('已切换到 '+m.name); loadModels(); loadCurrentModelBar(); }
        else toast(res.data.msg||'切换失败');
      }).catch(function(){ hideLoading(); toast('切换失败'); });
  });
}
function unloadModel(id){
  var m=state.models.find(function(x){return x.id===id});
  if(!m) return;
  confirmDialog('卸载模型','把 <b style="color:var(--accent)">'+m.name+'</b> 从内存卸载？下次使用时会重新加载。', function(){
    api('/api/models/'+m.file_name+'/unload', {method:'POST'})
      .then(function(res){
        if(res.data.ok){ toast('已卸载 '+m.name); loadModels(); }
        else toast(res.data.msg||'卸载失败');
      });
  });
}

function unloadAllModels(){
  confirmDialog('全部卸载','卸载所有非当前使用中的模型，释放内存？下次使用时会重新加载。（当前使用中的会自动跳过）', function(){
    api('/api/models/unload-all', {method:'POST'})
      .then(function(res){
        if(res.data.ok){ toast('已卸载 '+res.data.unloaded+' 个模型'); loadModels(); }
        else toast(res.data.msg||'卸载失败');
      });
  });
}

function deleteModel(id){
  var m=state.models.find(function(x){return x.id===id});
  if(!m) return;
  confirmDialog('删除模型','确定要删除 '+m.name+' 吗？', function(){
    api('/api/models/'+id, {method:'DELETE'}).then(function(res){
      if(res.data.ok){ toast('模型已删除'); loadModels(); }
      else toast(res.data.msg||'删除失败');
    });
  });
}
function openModelModal(){ document.getElementById('model-modal').classList.add('show'); }
function uploadModel(){
  var fileInput = document.querySelector('#model-modal input[type=file]');
  var f = fileInput && fileInput.files[0];
  if(!f){ toast('请选择模型文件'); return; }
  var nameInput = document.querySelector('#model-modal input[placeholder^="例如"]');
  var tagInput = document.getElementById('model-tags');
  var noteArea = document.querySelector('#model-modal textarea');
  var fd = new FormData();
  fd.append('file', f);
  fd.append('name', nameInput ? nameInput.value : f.name);
  fd.append('tags', tagInput ? tagInput.value : '');
  fd.append('note', noteArea ? noteArea.value : '');
  toast('上传中...');
  fetch(API + '/api/models/upload', {method:'POST', body: fd, credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.ok){ closeModal('model-modal'); toast('模型上传成功'); loadModels(); }
      else toast(d.msg||'上传失败');
    });
}

// ===== 历史 =====
function loadHistory(){
  // 普通用户只能看自己的记录，隐藏用户筛选下拉框
  var filterItem = document.getElementById('history-user-filter');
  if(filterItem){
    var wrap = filterItem.closest('.filter-item');
    if(wrap) wrap.style.display = (state.currentUser && state.currentUser.role === 'admin') ? '' : 'none';
  }
  // 孤儿文件清理属于磁盘级操作，仅管理员可用
  var _co = document.getElementById('btn-cleanup-orphans');
  if(_co) _co.style.display = (state.currentUser && state.currentUser.role === 'admin') ? '' : 'none';
  var sel = document.getElementById('history-user-filter');
  if(sel && sel.options.length <= 1){
    api('/api/usernames').then(function(res){
      if(res.data.ok){
        var cur = sel.value;
        sel.innerHTML = '<option value="all">全部用户</option>';
        (res.data.users||[]).forEach(function(u){
          var opt = document.createElement('option');
          opt.value = u;
          opt.textContent = u;
          sel.appendChild(opt);
        });
        sel.value = cur;
      }
    });
  }
  var u = (sel||{value:'all'}).value || 'all';
  var kw = state.historyKw || '';
  var page = state.historyPage || 1;
  var limit = state.historyLimit || 20;  api('/api/history?user='+encodeURIComponent(u)+'&kw='+encodeURIComponent(kw)+'&page='+page+'&limit='+limit).then(function(res){
    if(!res.data.ok){ if(res.status===401){ go('login'); } return; }
    state.records = res.data.records || [];
    state.historyTotal = res.data.total || 0;
    state.historyPage = res.data.page || 1;
    renderHistory();
  });
}
function historySearch(){
  state.historyKw = (document.getElementById('history-search') || {value:''}).value.trim();
  state.historyPage = 1;
  loadHistory();
}
function historyUserFilterChange(){
  state.historyPage = 1;
  loadHistory();
}
function historyGoPage(p){
  if(p < 1) p = 1;
  state.historyPage = p;
  loadHistory();
}
function renderHistoryPager(){
  var pager = document.getElementById('history-pager');
  if(!pager) return;
  var total = state.historyTotal || 0, page = state.historyPage || 1, limit = state.historyLimit || 20;
  var pages = Math.max(1, Math.ceil(total / limit));
  if(total === 0){ pager.innerHTML = '共 0 条'; return; }
  pager.innerHTML =
    '<button class="pg-btn"'+(page<=1?' disabled':'')+' onclick="historyGoPage('+(page-1)+')">上一页</button>'+
    '<span class="pg-info">第 '+page+' / '+pages+' 页 · 共 '+total+' 条</span>'+
    '<button class="pg-btn"'+(page>=pages?' disabled':'')+' onclick="historyGoPage('+(page+1)+')">下一页</button>';
}

// 编辑模式（勾选批量删除）
state.historyEditing = false;
state.historyCheckedIds = {};
// 分拣记录：编辑模式（默认关闭，点「编辑」后才开放勾选/批量删除，
// 与检测历史、反馈管理等处保持一致）
state.sortRecordsEditing = false;
state.sortRecordCheckedIds = {};
function toggleEditMode(){
  state.historyEditing = !state.historyEditing;
  document.getElementById('btn-edit-history').textContent = state.historyEditing ? '完成' : '编辑';
  document.getElementById('btn-batch-del').style.display = state.historyEditing ? 'inline-block' : 'none';
  if(!state.historyEditing) state.historyCheckedIds = {};
  renderHistory();
}

function renderHistory(){
  var tbody = document.getElementById('history-tbody');
  if(!tbody) return;
  var recs = (state.records||[]);   // 后端已按关键字+分页返回当前页
  tbody.innerHTML='';
  recs.forEach(function(r){
    var statParts=[];
    for(var k in r.stats){ statParts.push(k+': '+r.stats[k]); }
    var tr=document.createElement('tr');
    var dis = state.historyEditing ? '' : 'disabled';
    tr.innerHTML =
      '<td class="cb-col"><input type="checkbox" class="history-cb" value="'+r.id+'"'+(state.historyCheckedIds[r.id]?' checked':'')+' '+dis+' onchange="onHistoryCBClick('+r.id+', this.checked)"></td>'+
      '<td>'+(r.image_name||'(视频)').slice(0,40)+'</td>'+
      '<td class="hide-mobile">'+r.username+'</td>'+
      '<td class="hide-mobile">'+r.conclusion+'</td>'+
      '<td class="hide-mobile">'+statParts.join(', ')+'</td>'+
      '<td class="hide-mobile">'+r.created_at+'</td>'+
      '<td><span class="op-link" onclick="openDetail('+r.id+')">详情</span> '+
          '<span class="op-del" onclick="delRow(this,'+r.id+')">删除</span></td>';
    tbody.appendChild(tr);
  });
  renderHistoryPager();
  syncHistoryCheckAll();
  updateHistoryDelBtn();
}

// 统计当前页已选 / 其它页残留已选的条数。
// 勾选状态**跨页保留**（翻页不清除），所以本页之外可能还有已选记录，这里拆开显示
// —— 否则按钮上的数字会比当前页看到的勾选多，用户一脸问号（实际踩过）。
function historySelCounts(){
  var sel = state.historyCheckedIds || {};
  var cur = 0, total = 0;
  for(var id in sel){ total++; }
  document.querySelectorAll('.history-cb').forEach(function(c){
    if(sel[+c.value]) cur++;
  });
  return {total: total, cur: cur, other: total - cur};
}

// 「全选」框只反映**当前页**的勾选情况：本页全选→勾选，部分选→半选，全不选→不勾选。
// ⚠ 以前拿「累计已选数 === 当前页行数」来判断，跨页勾选时两边对不上，出现怪状态。
function syncHistoryCheckAll(){
  var ca = document.getElementById('history-checkall');
  if(!ca) return;
  ca.disabled = !state.historyEditing;
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.history-cb'));
  var n = boxes.filter(function(c){ return c.checked; }).length;
  ca.checked = boxes.length > 0 && n === boxes.length;
  ca.indeterminate = n > 0 && n < boxes.length;
}

// 「删除所选」按钮上显示已选条数；有其它页残留时一并标出。
function updateHistoryDelBtn(){
  var btn = document.getElementById('btn-batch-del');
  if(!btn) return;
  var c = historySelCounts();
  if(!c.total){ btn.textContent = '删除所选'; return; }
  btn.textContent = '删除所选（' + c.total + ' 条'
    + (c.other ? ' · 其它页 ' + c.other + ' 条' : '') + '）';
}

function onHistoryCBClick(id, checked){
  if(checked) state.historyCheckedIds[id] = true;
  else delete state.historyCheckedIds[id];
  syncHistoryCheckAll();
  updateHistoryDelBtn();
}

function toggleCheckAll(cb, sel){
  var cls = sel || '.history-cb';
  var store = cls === '.article-cb' ? state.articlesCheckedIds
            : cls === '.user-cb' ? state.usersCheckedIds
            : state.historyCheckedIds;
  document.querySelectorAll(cls).forEach(function(c){
    c.checked = cb.checked;
    var id = +c.value;
    if(cb.checked) store[id] = true;
    else delete store[id];
  });
  // 「全选」只作用于当前页；history 分支刷新全选框状态与按钮计数
  if(cls === '.history-cb' || !sel){ syncHistoryCheckAll(); updateHistoryDelBtn(); }
}
function resetHistoryFilter(){
  var s = document.getElementById('history-user-filter');
  if(s) s.value = 'all';
  var q = document.getElementById('history-search');
  if(q) q.value = '';
  state.historyKw = '';
  state.historyPage = 1;
  loadHistory();
  toast('筛选已重置');
}
// 清理磁盘上的孤儿文件：删除记录时若文件清理被拦截，图/视频会留在磁盘上无人认领。
// 这里做一次全量扫描，把不被任何检测记录引用的文件删掉；先预览再执行，避免误删。
function _fmtSize(bytes){
  if(!bytes) return '0 B';
  var units = ['B','KB','MB','GB'], i = 0, n = bytes;
  while(n >= 1024 && i < units.length - 1){ n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + units[i];
}
function cleanupOrphanFiles(){
  confirmDialog('清理孤儿文件', '将扫描上传目录，删除不被任何检测记录引用的图片/视频。建议先预览再执行。',
    function(){
      showLoading('正在扫描孤儿文件...', 60);
      api('/api/history/cleanup-orphans', {method:'POST', body: JSON.stringify({dry:true})})
        .then(function(res){
          hideLoading();
          var d = res.data || {};
          if(!d.ok){ toast(d.msg || '扫描失败'); return; }
          if(!d.deleted){
            toast('没有发现孤儿文件，磁盘是干净的');
            return;
          }
          var skipped = d.skipped ? ('（另有 ' + d.skipped + ' 个刚生成不到 3 分钟的文件被跳过）') : '';
          confirmDialog('确认清理',
            '共发现 ' + d.deleted + ' 个孤儿文件，约 ' + _fmtSize(d.freed_bytes) + '。' + skipped + '确定要删除吗？',
            function(){
              showLoading('正在清理孤儿文件...', 120);
              api('/api/history/cleanup-orphans', {method:'POST', body: JSON.stringify({dry:false})})
                .then(function(r2){
                  hideLoading();
                  var r = r2.data || {};
                  if(!r.ok){ toast(r.msg || '清理失败'); return; }
                  if(r.msg){ toast(r.msg); }
                  else if(r.failed){
                    toast('清理完成：成功 ' + r.deleted + ' 个，失败 ' + r.failed + ' 个。');
                  } else {
                    toast('已清理 ' + r.deleted + ' 个孤儿文件，释放 ' + _fmtSize(r.freed_bytes));
                  }
                })
                .catch(function(e){ hideLoading(); toast('清理失败：' + (e && e.message ? e.message : '网络错误')); });
            });
        })
        .catch(function(e){ hideLoading(); toast('扫描失败：' + (e && e.message ? e.message : '网络错误')); });
    });
}

function getCheckedIds(){
  return Object.keys(state.historyCheckedIds).map(function(id){return +id;});
}
// 删除类请求统一走这里：
// ① 失败后等 1.5s 再自动重试一次（删除幂等；很多失败只是瞬时网络抖动，立即重试会撞在同一个抖动窗口里）；
// ② 仍失败且调用方传了 verify 回调时，先核实目标记录是否实际已被删掉（请求可能已到后端），
//    核实已删 → 走 onOk，不再误报"删除失败"；
// ③ 确认失败时把**真实原因**显示出来，便于定位（不再只报一句"网络错误"）
function _delWithRetry(path, opts, onOk, failMsg, verify){
  function handle(res){
    if(res.data.ok){ if(onOk) onOk(res); }
    else { toast(res.data.msg || failMsg); }
    hideLoading();
  }
  function attempt(){
    api(path, opts).then(handle).catch(function(err){
      setTimeout(function(){
        api(path, opts).then(handle).catch(function(err2){
          if(typeof verify === 'function'){
            verify(function(alreadyDeleted){
              if(alreadyDeleted){ if(onOk) onOk({status:200, data:{ok:true, verified:true}}); }
              else { toast(failMsg + '（' + ((err2 && err2.message) || '网络错误') + '）'); }
              hideLoading();
            });
            return;
          }
          var why = (err2 && err2.message) ? err2.message : '未知网络错误';
          console.error('[删除失败]', path, err2, '(首次错误:', err, ')');
          toast(failMsg + '（' + why + '）');
          hideLoading();
        });
      }, 1500);
    });
  }
  attempt();
}

// 核实一批记录是否已不在库里（配合 _delWithRetry 的网络故障核实）
function verifyHistoryDeleted(ids, done){
  api('/api/history/exists', {method:'POST', body: JSON.stringify({ids:ids})})
    .then(function(res){
      done(!!(res.data && res.data.ok && (res.data.existing || []).length === 0));
    })
    .catch(function(){ done(false); });
}

function deleteSelected(){
  var ids = getCheckedIds();
  ids = ids.filter(function(x){ return !isNaN(x) && x > 0; });   // 过滤异常 id，避免后端 int() 报错
  if(!ids.length){ toast('请先勾选要删除的记录'); return; }
  confirmDialog('删除所选记录','确定要删除选中的 '+ids.length+' 条记录吗？删除后不可恢复。', function(){
    showLoading('正在删除所选 '+ids.length+' 条记录...', 30);
    _delWithRetry('/api/history/batch-delete',
      {method:'POST', body: JSON.stringify({ids:ids})},
      function(res){
        // 关键：删除成功后必须清空勾选集。以前这里只刷新列表、不清 state.historyCheckedIds，
        // 导致已删掉的 id 继续留在集合里 —— 下一次翻页勾选时按钮会把这些"幽灵"一起计数
        // （20+20 显示成 40），并且把已删除的 id 再次发给后端。
        state.historyCheckedIds = {};
        if(res.data && res.data.verified){ toast('网络波动，已核实：所选记录均已删除成功'); }
        else { toast('已删除 '+((res.data && res.data.deleted)||0)+' 条'); }
        state.historyPage = 1; loadHistory();
      },
      '删除失败',
      function(done){ verifyHistoryDeleted(ids, done); });
  });
}
function clearAllHistory(){
  confirmDialog('删除全部记录','确定要清空全部检测历史吗？此操作不可恢复！', function(){
    showLoading('正在清空全部检测历史...', 30);
    api('/api/history/clear', {method:'POST'})
      .then(function(res){
        if(res.data.ok){ toast('已清空 '+res.data.deleted+' 条记录'); state.historyPage = 1; loadHistory(); }
        else { toast(res.data.msg||'清空失败'); }
        hideLoading();
      })
      .catch(function(){ toast('网络错误，清空失败'); hideLoading(); });
  });
}

// ===== 工业控制 =====
function indGetDeviceId(){
  var did = '';
  try{
    did = sessionStorage.getItem('_ind_device_id');
    if(!did){
      did = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
      sessionStorage.setItem('_ind_device_id', did);
    }
  }catch(e){
    did = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
  }
  return did;
}

var _ind = {
  connected: false,
  busy: false,
  viaHome: true,        // 去姿态行程模式：true=经原点过渡（默认，防碰撞） false=直达
  moveSpeed: 'normal',  // 动作组每步时长的速度档位（slow/normal/fast），全局共享
  lastJointTouch: 0,    // 最近一次手动操作滑块的时间戳，用于避免回读抢滑块
  pumpState: 'off',
  cameraOn: false,
  inferOn: false,
  sorterRunning: false,
  _pendingClass: null,
  estop: false,
  latestDetection: null,
  triggerMode: 'basic',        // 规则模式：basic=普通规则 / advanced=高级规则（按模型记忆）
  triggerRules: {},            // 高级规则 {类别:{priority,min_count,conf,cooldown,action}}
  triggerState: {},            // 每类连续帧计数与上次触发时刻（仅内存）
  triggerTuning: {             // 触发调优（按模型记忆，弹窗可调）：仅仲裁帧数一项
    arb_frames: 6,             // 仲裁窗帧数：首个合格者出现后等待 N 帧再放行（0=关闭；有效取值 4~10，1~3 不允许）
  },                           // 防抖帧数（3）与失效时间（500ms）均已写死，见 _IND_DEBOUNCE_FRAMES / _IND_EXPIRE_MS
  arb: null,                   // 仲裁窗运行时状态 {active,best,frames,need,startedAt,lastAt}
  sortEditing: false,      // 分拣记录编辑模式（开放勾选/批量删除）
  _recChecked: {},         // 已勾选的记录 id 集合
  sorterBusy: false,
  sorterPhase: 'idle',
  _sorterTimer: null,
  _lastSortResultTime: 0,
  statusTimer: null,
  camTimer: null,
  servoTimers: {},
  poses: {},
  statsScope: 'all',        // 统计/记录范围：'me'=只看我的，'all'=全部人
  curModel: '',
  areas: [],
  classMap: {},
  selectedClasses: [],
  pageLocked: false,
  _pageHeartbeatTimer: null
};

var JOINT_NAMES = ['J1 底座', 'J2 大臂', 'J3 小臂', 'J4 腕部', 'J5 腕部2'];
function getPoseList(){
  var list = [{key:'home', label:'原点'}, {key:'pick', label:'抓取位'}];
  (_ind.areas || []).forEach(function(a){
    list.push({key: a.key, label: a.label || a.key});
  });
  return list;
}

function indLoadArmConfig(){
  fetch('/api/arm/config').then(function(r){return r.json();}).then(function(res){
    if(res.ok){
      _ind.areas = res.areas || [];
      _ind.classMap = res.class_area_map || {};
      _ind.poses = res.poses || {};
      _ind.selectedClasses = res.selected_classes || [];
      _ind.lastPort = res.serial_port || '';
      // 类别触发规则（按当前模型记忆；缺失类别由前端补默认行）
      _ind.triggerRules = res.class_trigger_by_model || {};
      _ind.triggerMode = (res.trigger_mode === 'advanced') ? 'advanced' : 'basic';
      _ind._trDraft = null;   // 配置重载（切模型/进页面）：弹窗草稿作废，下次打开重新初始化
      // 触发调优（按模型记忆）：仅仲裁帧数可调；防抖（3 帧）与失效时间（500ms）已写死，不从这里读
      _ind.triggerTuning = {
        arb_frames: (res.tuning && typeof res.tuning.arb_frames === 'number') ? res.tuning.arb_frames : 6,
      };
      // 配置重载（切模型/进页面）：防抖累计+仲裁窗全部失效；并归零冷却计时
      // （不同模型/新会话的冷却本就该从零开始）
      indInvalidateTrigger(true);
      // 组映射保险提前拉取：候选筛选在**高级行程模式**下要用 _ag.classGroupMap
      // （indInitPage 的 agLoadGroups 已经会拉，这里双保险一次，避免时序竞态；
      //   组映射本身按当前模型解析，拉到的就是当前模型那份）
      if(_ind.triggerMode === 'advanced' || agIsAdvanced()){ agLoadGroups(function(){}); }
      indRenderTriggerSummary();
      // 放置位变化时，规则表里可能残留旧放置位引用 —— 交由映射表自身容错处理
      indRefreshTriggerRules();
      // 动作速度档位（全局）：决定动作组每步时长按位移计算的系数
      if(res.move_speed) _ind.moveSpeed = res.move_speed;
      indRenderMoveSpeed();
      indRenderPoseBtns();
      indUpdatePoseBtns();
      indRenderClasses();
      indSetStatsScope(_ind.statsScope || 'all');   // 会刷新统计+记录，并同步范围按钮
      indRefreshClassFilter();
      // 放置位数据到位后标记 + 重刷记录列表：
      // 记录渲染要靠放置位列表把 place_xxx 翻译成汉字，若数据没到就渲染，
      // 会被误判成"已删除"（实际还在）——表现为刷新前后显示不一致
      _ind.areasLoaded = true;
      indLoadSortRecords();
    }
  }).catch(function(){});
}

function indOpenClassPicker(){
  var all = _ind.modelClasses || [];
  if(!all.length){ toast('请先开启摄像头加载模型'); return; }
  var selected = (_ind.selectedClasses || []).slice();
  // 构建弹窗
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card);border:1px solid var(--line-soft);border-radius:14px;padding:24px;width:90%;max-width:420px;max-height:80vh;display:flex;flex-direction:column';
  var titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px';
  var title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:700;color:#f2efe9';
  title.textContent = '选择用于分拣的类别';
  var clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-ghost btn-sm';
  clearBtn.style.cssText = 'padding:3px 10px;font-size:11px;color:var(--red);border-color:rgba(224,101,90,.3)';
  clearBtn.textContent = '清除选择';
  clearBtn.onclick = function(){
    selected = [];
    checkboxes.forEach(function(cb){ cb.checked = false; });
    countLabel.textContent = '已选 0 / 4';
  };
  titleRow.appendChild(title);
  titleRow.appendChild(clearBtn);
  var sub = document.createElement('div');
  sub.style.cssText = 'font-size:12px;color:var(--text-3);margin-bottom:14px';
  sub.textContent = '从模型全部 ' + all.length + ' 个类别中挑选，最多 4 个';
  var countLabel = document.createElement('div');
  countLabel.style.cssText = 'font-size:12px;color:var(--accent);margin-bottom:10px;font-weight:600';
  countLabel.textContent = '已选 ' + selected.length + ' / 4';
  // 搜索框：类别多（如 COCO 80 类）时快速定位，输入即过滤
  var search = document.createElement('input');
  search.type = 'text';
  search.placeholder = '🔍 搜索类别...';
  search.style.cssText = 'width:100%;padding:7px 10px;margin-bottom:10px;border-radius:8px;' +
    'border:1px solid var(--line-soft);background:var(--card-2,#0e131c);color:var(--text-1);font-size:13px';
  var rows = [];
  var checkboxes = [];
  var listWrap = document.createElement('div');
  listWrap.style.cssText = 'flex:1;overflow-y:auto;border:1px solid var(--line-soft);border-radius:8px;padding:8px';
  all.forEach(function(c){
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-1)';
    row.onmouseenter = function(){ row.style.background = 'rgba(201,152,107,.08)'; };
    row.onmouseleave = function(){ row.style.background = 'transparent'; };
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.indexOf(c) >= 0;
    cb.style.cssText = 'accent-color:var(--accent);width:16px;height:16px;flex-shrink:0';
    var lbl = document.createElement('span');
    lbl.textContent = c;
    lbl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    cb.onchange = function(){
      if(cb.checked){
        if(selected.length >= 4){ cb.checked = false; toast('最多选择 4 个类别'); return; }
        if(selected.indexOf(c) < 0) selected.push(c);
      } else {
        var idx = selected.indexOf(c);
        if(idx >= 0) selected.splice(idx, 1);
      }
      countLabel.textContent = '已选 ' + selected.length + ' / 4';
    };
    row.dataset.cls = c;                       // 供搜索过滤匹配
    row.appendChild(cb);
    row.appendChild(lbl);
    listWrap.appendChild(row);
    rows.push(row);
    checkboxes.push(cb);
  });
  search.oninput = function(){
    var kw = search.value.trim().toLowerCase();
    rows.forEach(function(row){
      row.style.display = (!kw || row.dataset.cls.toLowerCase().indexOf(kw) >= 0) ? '' : 'none';
    });
  };
  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:16px';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.style.cssText = 'flex:1;padding:10px';
  cancelBtn.textContent = '取消';
  var okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.style.cssText = 'flex:1;padding:10px;font-weight:700';
  okBtn.textContent = '确认选择';
  function closeDlg(){ if(overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  cancelBtn.onclick = closeDlg;
  okBtn.onclick = function(){
    fetch('/api/arm/selected-classes', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({classes: selected})})
      .then(function(r){return r.json();})
      .then(function(res){
        if(res.ok){
          _ind.selectedClasses = selected.slice();
          // ⚠ 以前这里直接 `_ind.classMap = {}`，把整份"类别→放置位"映射清空：
          // 于是取消勾选再勾回来时，普通模式的下拉框变成"未映射"，
          // 非得刷新整个页面才会恢复（后端其实按模型记着，问题只在前端没重新拉）。
          // 现在：仅丢弃"已不再选中"的类别，选中类别的旧映射先留着，
          // 随后统一再拉一次配置，以后端那份（按模型记忆的）为准。
          var _keptMap = {};
          selected.forEach(function(c){ if(_ind.classMap[c]) _keptMap[c] = _ind.classMap[c]; });
          _ind.classMap = _keptMap;
          // 收尾统一走这里：刷新统计与触发摘要，并重新拉取配置
          function _finish(){
            indLoadSortStats();
            indRefreshClassFilter();
            closeDlg();
            indLoadArmConfig();   // 以后端那份（按模型记忆的）映射为准重刷界面
          }
          // 自动补齐放置位：数量不够时自动添加
          var need = selected.length - (_ind.areas || []).length;
          if(need > 0){
            var newAreas = (_ind.areas || []).slice();
            for(var i = 0; i < need; i++){
              var idx = newAreas.length + 1;
              newAreas.push({key: 'place_' + Date.now().toString(36) + '_' + i, label: '放置位' + idx});
            }
            fetch('/api/arm/config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({areas: newAreas})})
              .then(function(r2){return r2.json();})
              .then(function(res2){
                if(res2.ok){
                  _ind.areas = newAreas;
                  indRenderClasses();
                  indRenderPoseBtns();
                  indUpdatePoseBtns();
                  toast(res.msg + '，已自动补齐 ' + need + ' 个放置位');
                } else {
                  indRenderClasses();
                  toast(res.msg);
                }
                _finish();
              })
              .catch(function(){ indRenderClasses(); toast(res.msg); _finish(); });
          } else {
            indRenderClasses();
            toast(res.msg);
            _finish();
          }
        } else {
          toast(res.msg || '保存失败');
        }
      })
      .catch(function(){ toast('网络错误'); });
  };
  overlay.onclick = function(e){ if(e.target === overlay) closeDlg(); };
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  box.appendChild(titleRow);
  box.appendChild(sub);
  box.appendChild(countLabel);
  box.appendChild(search);
  box.appendChild(listWrap);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function indRenderAreaTags(){
  var areaBox = document.getElementById('ind-area-tags');
  if(!areaBox) return;
  areaBox.innerHTML = '';
  if((_ind.areas||[]).length){
    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:11px;color:var(--text-3);align-self:center;margin-right:2px';
    lbl.textContent = '放置位：';
    areaBox.appendChild(lbl);
    (_ind.areas||[]).forEach(function(a){
      var used = false;
      for(var ck in _ind.classMap){ if(_ind.classMap[ck]===a.key){used=true;break;} }
      var tag = document.createElement('span');
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px 2px 8px;border-radius:10px;background:rgba(201,152,107,.1);color:var(--text-1);border:1px solid rgba(201,152,107,.25)';
      tag.textContent = a.label || a.key;
      if(used){
        var usedDot = document.createElement('span');
        usedDot.style.cssText = 'width:5px;height:5px;border-radius:50%;background:#7ec87e';
        usedDot.title = '已被使用';
        tag.insertBefore(usedDot, tag.firstChild);
      }
      // 重命名入口（✎）：手动添加 / 自动补齐的放置位都支持改名
      var ren = document.createElement('span');
      ren.style.cssText = 'cursor:pointer;opacity:.5;font-weight:700;padding:0 2px';
      ren.textContent = '✎';
      ren.title = '重命名此放置位';
      ren.onclick = function(){ indRenameArea(a.key); };
      tag.appendChild(ren);
      var del = document.createElement('span');
      del.style.cssText = 'cursor:pointer;opacity:.5;font-weight:700;padding:0 2px';
      del.textContent = '×';
      del.title = '删除此放置位';
      del.onclick = function(){ indRemoveArea(a.key); };
      tag.appendChild(del);
      areaBox.appendChild(tag);
    });
  }
}

function indRenderClasses(){
  var tagsBox = document.getElementById('ind-class-tags');
  var mapBox = document.getElementById('ind-class-map-list');
  if(!tagsBox || !mapBox) return;
  var allClasses = _ind.modelClasses || [];
  var classes = (_ind.selectedClasses && _ind.selectedClasses.length) ? _ind.selectedClasses : [];
  // 类别标签
  tagsBox.innerHTML = '';
  if(classes.length){
    classes.forEach(function(c){
      var tag = document.createElement('span');
      tag.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(201,152,107,.15);color:var(--accent);border:1px solid rgba(201,152,107,.3)';
      tag.textContent = c;
      tagsBox.appendChild(tag);
    });
  } else if(allClasses.length){
    tagsBox.innerHTML = '<span style="font-size:11px;color:var(--text-3)">未选择类别，点右侧「类别选择」挑选（最多4个）</span>';
  } else {
    tagsBox.innerHTML = '<span style="font-size:11px;color:var(--text-3)">加载模型后自动识别类别</span>';
  }
  // 放置位标签（始终显示，不随类别隐藏）
  indRenderAreaTags();
  // 类别增删后同步刷新「模型识别类别触发逻辑」摘要
  // ⚠ 必须放在下面两个 return **之前**：以前这行写在函数末尾，
  //    全部取消勾选时会在下面"请先点击类别选择"处提前返回，摘要永远刷新不到
  //    → 页面残留上一次的规则文字，只有手动刷新浏览器才消失。
  indRenderTriggerSummary();
  // 映射列表
  mapBox.innerHTML = '';
  if(!allClasses.length){
    mapBox.innerHTML = '<div style="font-size:11px;color:var(--text-3);text-align:center;padding:4px">请先开启摄像头加载模型</div>';
    return;
  }
  if(!classes.length){
    mapBox.innerHTML = '<div style="font-size:11px;color:var(--text-3);text-align:center;padding:8px">请先点击「类别选择」挑选用于分拣的类别（最多4个）</div>';
    return;
  }
  classes.forEach(function(cls){
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px';
    var clsLabel = document.createElement('span');
    clsLabel.style.cssText = 'font-size:12px;color:var(--text-1);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    clsLabel.textContent = cls;
    var sel = document.createElement('select');
    sel.className = 'input';
    sel.style.cssText = 'flex:1;font-size:11px;padding:4px 8px;min-width:0';
    // 空选项
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '-- 未映射 --';
    sel.appendChild(opt0);
    if(agIsAdvanced()){
      // 高级模式：类别 -> 动作组（允许多类别指向同一条组，不做唯一性禁用）
      (_ag.groups || []).forEach(function(g){
        var opt = document.createElement('option');
        opt.value = String(g.id);
        opt.textContent = g.name;
        sel.appendChild(opt);
      });
      var curGid = (_ag.classGroupMap || {})[cls];
      sel.value = curGid ? String(curGid) : '';
      sel.onchange = function(){ agOnClassGroupChange(cls, sel.value); };
    } else {
      // 普通模式：类别 -> 放置位（放置位唯一，已被占用的禁用）
      (_ind.areas || []).forEach(function(a){
        var opt = document.createElement('option');
        opt.value = a.key;
        opt.textContent = a.label || a.key;
        var usedByOther = false;
        for(var ck in _ind.classMap){
          if(ck !== cls && _ind.classMap[ck] === a.key){ usedByOther = true; break; }
        }
        if(usedByOther){ opt.disabled = true; opt.textContent = (a.label||a.key) + '（已占用）'; }
        sel.appendChild(opt);
      });
      sel.value = _ind.classMap[cls] || '';
      sel.onchange = function(){ indOnClassMapChange(cls, sel.value); };
    }
    row.appendChild(clsLabel);
    row.appendChild(sel);
    mapBox.appendChild(row);
  });
}

function indOnClassMapChange(cls, areaKey){
  if(areaKey) _ind.classMap[cls] = areaKey;
  else delete _ind.classMap[cls];
  // 立即重新渲染，其他下拉框马上更新占用状态
  indRenderClasses();
  // 后台保存
  fetch('/api/arm/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({class_area_map: _ind.classMap})
  }).then(function(r){return r.json();}).then(function(res){
    if(!res.ok) toast(res.msg || '保存失败');
  }).catch(function(){ toast('保存失败'); });
}

function indAddArea(){
  promptDialog('添加放置位', '如：后放位、A区、料盒1', function(name){
  if(!name || !name.trim()) return;
  var key = 'place_' + Date.now().toString(36);
  var newAreas = (_ind.areas || []).concat([{key: key, label: name}]);
  showLoading('添加放置位...', 20);
  fetch('/api/arm/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({areas: newAreas})
  }).then(function(r){return r.json();}).then(function(res){
    hideLoading();
    if(res.ok){
      _ind.areas = newAreas;
      indRenderClasses();
      indRenderPoseBtns();
      indUpdatePoseBtns();
      toast('已添加放置位：' + name + '，请去标定');
    } else toast(res.msg || '添加失败');
  }).catch(function(){ hideLoading(); toast('添加失败'); });
  });
}

function indClearPoses(){
  if(!_ind.poses || !Object.keys(_ind.poses).length){ toast('当前没有已标定的动作位'); return; }
  var count = Object.keys(_ind.poses).length;
  confirmDialog('清空标定', '确定要清空全部 ' + count + ' 个动作位的标定数据吗？<br>原点、抓取位、所有放置位的标定都将被清除，需要重新标定。', function(){
    showLoading('清空标定中...', 20);
    fetch('/api/arm/poses/clear', {method:'POST'})
      .then(function(r){return r.json();})
      .then(function(res){
        hideLoading();
        if(res.ok){
          _ind.poses = {};
          indRenderPoseBtns();
          indUpdatePoseBtns();
          toast(res.msg);
        } else {
          toast(res.msg || '清空失败');
        }
      })
      .catch(function(){ hideLoading(); toast('网络错误'); });
  });
}

function indRenameArea(key){
  var area = (_ind.areas||[]).find(function(a){return a.key===key;});
  if(!area) return;
  promptDialog('重命名放置位', '新的名称（如：后放位、A区）', function(name){
    if(!name || !name.trim()) return;
    var raw = name.trim();
    // 先用**原始输入**判断是否真的没改：
    // 原先是先截断再比较，长名字被截断后会误报"名称未变化"（其实是名字被截短了）
    if(raw === (area.label || area.key)){ toast('名称未变化'); return; }
    // 超过上限**直接拒绝**，不做截断（用户要求：宁可失败也不给一个被砍掉的名字）
    var MAX = 15;
    if(raw.length > MAX){
      toast('名字过长，重命名失败（最多 ' + MAX + ' 个字符）', 'error');
      return;
    }
    var name = raw;
    // 只改 label，key 保持不变 —— 历史记录、类别映射都不受影响
    var newAreas = (_ind.areas||[]).map(function(a){
      return a.key === key ? {key: a.key, label: name} : a;
    });
    fetch('/api/arm/config', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({areas: newAreas})
    }).then(function(r){return r.json();}).then(function(res){
      if(res.ok){
        _ind.areas = newAreas;
        indRenderAreaTags();
        indRenderClasses();
        indRenderPoseBtns();
        indUpdatePoseBtns();
        // 立刻刷新记录列表：历史记录按 key 实时查标签，
        // 不用等 5 秒轮询 / 手动点刷新
        indLoadSortRecords();
        toast('已重命名为「' + name + '」');
      } else {
        toast(res.msg || '重命名失败');
      }
    }).catch(function(){ toast('请求失败'); });
  }, area.label || area.key);
}

function indRemoveArea(key){
  var area = (_ind.areas||[]).find(function(a){return a.key===key;});
  if(!area) return;
  var usedBy = [];
  for(var ck in _ind.classMap){ if(_ind.classMap[ck]===key) usedBy.push(ck); }
  var msg = '确定删除放置位「' + (area.label||area.key) + '」吗？';
  if(usedBy.length) msg += '\n该放置位已被类别 ' + usedBy.join('、') + ' 使用，删除后将自动解除映射。';
  confirmDialog('删除放置位', msg.replace(/\n/g,'<br>'), function(){
  // 从列表删除
  var newAreas = (_ind.areas||[]).filter(function(a){return a.key!==key;});
  // 解除相关映射
  usedBy.forEach(function(cls){ delete _ind.classMap[cls]; });
  _ind.areas = newAreas;
  indRenderClasses();
  indRenderPoseBtns();
  indUpdatePoseBtns();
  // 后台保存
  fetch('/api/arm/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({areas: newAreas, class_area_map: _ind.classMap})
  }).then(function(r){return r.json();}).then(function(res){
    if(!res.ok) toast(res.msg || '删除失败');
    else toast('已删除放置位：' + (area.label||area.key));
  }).catch(function(){ toast('删除失败'); });
  });
}

function indRefreshPorts(){
  fetch('/api/arm/ports').then(function(r){return r.json();}).then(function(res){
    var sel = document.getElementById('arm-port-select');
    if(!sel) return;
    sel.innerHTML = '';
    if(res.ok && res.ports && res.ports.length){
      res.ports.forEach(function(p){
        var opt = document.createElement('option');
        opt.value = p.device;
        opt.textContent = p.device + ' - ' + (p.description||'');
        sel.appendChild(opt);
      });
    } else {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未检测到串口';
      sel.appendChild(opt);
    }
  }).catch(function(){ toast('串口扫描失败'); });
}

function indConnectArm(){
  var port = document.getElementById('arm-port-select').value;
  if(!port){ toast('请选择串口号'); return; }
  showLoading('正在连接机械臂...', 20);
  fetch('/api/arm/connect', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({port:port})})
    .then(function(r){return r.json();})
    .then(function(res){
      hideLoading();
      if(res.ok){
        toast(res.msg||'连接成功');
        _ind.connected = true;
        indUpdateUI();
        indRenderJoints();
        indRenderPoseBtns();
        indSyncStatusPoll();   // 连上后先拉一次并进入空闲心跳（没启用机械臂功能就不高频）
        // 检测串口号变化，提示设备变更
        var oldPort = _ind.lastPort || '';
        if(oldPort && oldPort !== port && (_ind.poses && Object.keys(_ind.poses).length)){
          _ind.lastPort = port;
          setTimeout(function(){
            confirmDialog('检测到设备变更',
              '当前串口号从 <b>' + oldPort + '</b> 切换为 <b>' + port + '</b>，可能是不同的机械臂硬件。<br><br>' +
              '<span style="color:var(--text-3);font-size:12px">建议重新标定动作位（原点/抓取位/放置位），以确保动作精度。<br>如果是同一台设备，也可以直接复用现有标定，点确定即可。</span>',
              function(){ /* 用户确认，不做额外操作 */ });
          }, 500);
        } else {
          _ind.lastPort = port;
        }
      } else {
        toast(res.msg||'连接失败');
      }
    })
    .catch(function(){ hideLoading(); toast('连接请求失败'); });
}

function indDisconnectArm(){
  confirmDialog('断开机械臂','确定要断开机械臂连接吗？', function(){
    showLoading('正在断开...', 20);
    fetch('/api/arm/disconnect', {method:'POST'}).then(function(r){return r.json();}).then(function(res){
      hideLoading();
      toast(res.msg||'已断开');
      _ind.connected = false;
      _ind.busy = false;
      indStopStatusPoll();
      indUpdateUI();
      indUpdatePoseBtns();
    }).catch(function(){ hideLoading(); toast('断开失败'); });
  });
}

// 机械臂状态轮询**按需启停**：
// 只有真正在用它的时候才高频拉（自动分拣运行中 / 动作组运行中 / 气泵吸气倒计时中）；
// 连上了但没启用任何机械臂功能时，降到 20 秒一次心跳（仅用于发现断线、同步状态），
// 不再每秒/每 3 秒空转——这些请求会挤占主线程与带宽，直接压低推理帧率。
function indNeedsFastStatus(){
  return !!(_ind.sorterRunning || _ind.agRunning || _ind.pumpState === 'suck');
}
function indWantPollInterval(){
  if(!_ind.connected) return 20000;
  if(_ind.agRunning) return 600;          // 动作组：每步 1~2s，慢了会漏步骤
  if(indNeedsFastStatus()) return 1000;   // 自动分拣/气泵：1s 足够跟手
  return 20000;                           // 空闲：只留心跳
}
// 按当前需要把轮询切到正确节奏（幂等：节奏没变就不重启定时器）
function indSyncStatusPoll(){
  if(!_ind.connected){ indStopStatusPoll(); return; }
  var want = indWantPollInterval();
  if(_ind._pollInterval !== want || !_ind.statusTimer){
    indStartStatusPoll(want);
  }
}

function indStartStatusPoll(interval){
  indStopStatusPoll();
  _ind._pollInterval = interval || 20000;
  _ind.statusTimer = setInterval(indFetchStatus, _ind._pollInterval);
  indFetchStatus();
}

function indStopStatusPoll(){
  if(_ind.statusTimer){ clearInterval(_ind.statusTimer); _ind.statusTimer=null; }
}

function indFetchStatus(){
  fetch('/api/arm/status').then(function(r){return r.json();}).then(function(res){
    if(res.ok){
      var wasConnected = _ind.connected;
      _ind.connected = res.connected;
      // 动作组运行中也视为占用（否则步骤间隙界面会误判空闲而放开操作）
      var wasBusy = _ind.busy;
      _ind.busy = !!(res.busy || (res.run && res.run.running));
      _ind.agRunning = !!(res.run && res.run.running);   // 供轮询节奏判断
      // 一轮分拣/动作组刚刚执行完毕（busy  true→false）：防抖累计与仲裁窗全部失效。
      // 这一轮的货已经处理掉，画面里残留的累计很可能是它的/旧目标的，不能带到下一轮
      // （确定性事件清零，不依赖失效时间——写死的 500ms 覆盖不了执行期间的空白）
      if(wasBusy && !_ind.busy && _ind.sorterRunning){ indInvalidateTrigger(); }
      if(typeof res.via_home === 'boolean') _ind.viaHome = res.via_home;
      indRenderViaHome();
      // 行程模式（普通/高级）由服务端按用户返回；UI 每次都刷新（修复首次进入不选中），
      // 数据仅在模式变化时重载，避免轮询打接口
      if(res.mode){
        var modeChanged = (res.mode !== _ag.mode);
        _ag.mode = res.mode;
        agUpdateModeUI();
        if(modeChanged){
          if(agIsAdvanced()){ agLoadGroups(); } else { indRenderClasses(); }
        }
      }
      // 编辑器按钮禁用态随「连接/运行状态」刷新
      agUpdateRunUI(res.run);
      // 编辑器打开时，用状态里的当前姿态兜底同步滑块（防漏）
      if(_ag.open && res.current_pose) agSyncJointsFromPose(res.current_pose);
      _ind.pumpState = res.pump_state;
      _ind.poses = res.poses || {};
      // 气泵吸气倒计时：用后端剩余秒数校准，并维持本地 1 秒 ticker
      if(typeof res.pump_timeout_sec === 'number') _ind.pumpTimeoutSec = res.pump_timeout_sec;
      if(_ind.pumpState === 'suck'){
        // 校准加阈值：本地 ticker 每秒递减，后端每 1~3 秒轮询回来一次，
        // 两边计数相位天然有半秒内的差；若每次都强行同步，数字会来回跳、吞秒。
        // 只在与本地相差 1.5 秒以上时才采纳后端值（真偏差才校正）。
        if(typeof res.pump_remaining_sec === 'number'){
          var localR = _ind.pumpRemaining;
          if(localR == null || Math.abs(localR - res.pump_remaining_sec) > 1.5){
            _ind.pumpRemaining = res.pump_remaining_sec;
          }
        }
        indEnsurePumpCountdown();
      } else {
        indStopPumpCountdown();
      }
      indUpdateUI();
      indRenderPoseBtns();
      indUpdatePoseBtns();
      // 空闲时从硬件回读真实关节位置，驱动滑块跟随（运动中回读会得到中间值）
      indMaybeReadPose();
      // 检测到断线：提示用户
      if(wasConnected && !res.connected){
        toast('机械臂连接已断开，请检查数据线');
        indStopStatusPoll();
      }
      // 按"是否在用机械臂"调整轮询节奏：用得上就高频，空闲只留心跳
      indSyncStatusPoll();
    }
  }).catch(function(){});
}

function indUpdateUI(){
  // 连接状态
  var connDot = document.getElementById('arm-conn-dot');
  var connVal = document.getElementById('arm-conn-val');
  if(connDot){ connDot.className = 'ind-status-dot ' + (_ind.connected?'on':'off'); }
  if(connVal){ connVal.textContent = _ind.connected ? '已连接' : '未连接'; }

  // 忙闲状态
  var busyDot = document.getElementById('arm-busy-dot');
  var busyVal = document.getElementById('arm-busy-val');
  if(busyDot){ busyDot.className = 'ind-status-dot ' + (_ind.busy?'warn':(_ind.connected?'on':'off')); }
  if(busyVal){ busyVal.textContent = _ind.busy ? '运行中' : (_ind.connected?'空闲':'--'); }

  // 气泵
  var pumpDot = document.getElementById('pump-dot');
  var pumpVal = document.getElementById('pump-val');
  var pumpMap = {suck:'吸气中', release:'放气中', off:'停止'};
  if(pumpDot){ pumpDot.className = 'ind-status-dot ' + (_ind.pumpState==='suck'?'on':(_ind.pumpState==='release'?'warn':'off')); }
  if(pumpVal){ pumpVal.textContent = pumpMap[_ind.pumpState] || '停止'; }

  // 按钮显隐
  var connBtn = document.getElementById('arm-connect-btn');
  var discBtn = document.getElementById('arm-disconnect-btn');
  if(connBtn) connBtn.style.display = _ind.connected ? 'none' : '';
  if(discBtn) discBtn.style.display = _ind.connected ? '' : 'none';

  // 气泵按钮
  ['suck','release'].forEach(function(a){
    var btn = document.getElementById('pump-'+a+'-btn');
    if(btn) btn.disabled = !_ind.connected || _ind.busy;
  });

  // 关节滑块和加减按钮
  for(var si=0;si<5;si++){
    var sl = document.getElementById('jslider-'+si);
    if(sl) sl.disabled = !_ind.connected || _ind.busy;
    var mb = document.getElementById('jminus-'+si);
    var pb = document.getElementById('jplus-'+si);
    if(mb) mb.disabled = !_ind.connected || _ind.busy;
    if(pb) pb.disabled = !_ind.connected || _ind.busy;
  }

  // 分拣按钮
  indUpdateSorterBtn();
}

function stepJoint(sid, delta){
  var slider = document.getElementById('jslider-'+sid);
  var valEl = document.getElementById('jval-'+sid);
  if(!slider) return;
  _ind.lastJointTouch = Date.now();  // 标记手动操作，避免回读结果抢滑块
  var v = Math.max(500, Math.min(2500, parseInt(slider.value) + delta));
  slider.value = v;
  if(valEl) valEl.textContent = v;
  // 短 duration 连续下发，机械臂平滑跟随
  fetch('/api/arm/move', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({servo_id:sid, pwm:v, duration:150})
  }).then(function(r){return r.json();}).catch(function(){});
}

function bindHoldButton(btn, stepFn){
  var holdTimer=null, repeatTimer=null;
  function start(e){
    if(e.cancelable) e.preventDefault();
    stepFn();
    holdTimer = setTimeout(function(){
      repeatTimer = setInterval(stepFn, 120);
    }, 400);
  }
  function stop(){
    if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
    if(repeatTimer){clearInterval(repeatTimer);repeatTimer=null;}
  }
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', start, {passive:false});
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
  btn.addEventListener('touchend', stop);
  btn.addEventListener('touchcancel', stop);
}

function indResetJoints(){
  if(!_ind.connected){ toast('机械臂未连接'); return; }
  for(var si=0;si<5;si++){
    var slider = document.getElementById('jslider-'+si);
    var valEl = document.getElementById('jval-'+si);
    if(slider){ slider.value = 1500; }
    if(valEl){ valEl.textContent = '1500'; }
  }
  // 群控回中位
  fetch('/api/arm/move-batch', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({servos:{0:1500,1:1500,2:1500,3:1500,4:1500}, duration:800})
  }).then(function(r){return r.json();}).then(function(res){
    toast(res.msg || '所有关节已重置到中位');
  }).catch(function(){ toast('重置失败'); });
}

function indRenderJoints(){
  var box = document.getElementById('arm-joints');
  if(!box) return;
  box.innerHTML = '';
  for(var i=0;i<5;i++){
    (function(sid){
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px';
      var name = document.createElement('span');
      name.style.cssText = 'width:64px;font-size:12px;color:var(--text-2);flex-shrink:0';
      name.textContent = JOINT_NAMES[sid];
      var val = document.createElement('span');
      val.style.cssText = 'width:48px;font-size:12px;font-family:monospace;text-align:right;flex-shrink:0';
      val.id = 'jval-'+sid;
      val.textContent = '1500';
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 500; slider.max = 2500; slider.value = 1500;
      slider.className = 'ind-slider';
      slider.style.flex = '1';
      slider.id = 'jslider-'+sid;
      slider.oninput = function(){
        val.textContent = this.value;
        _ind.lastJointTouch = Date.now();  // 标记手动操作，避免回读结果抢滑块
        // 防抖
        if(_ind.servoTimers[sid]) clearTimeout(_ind.servoTimers[sid]);
        _ind.servoTimers[sid] = setTimeout(function(){ indMoveServo(sid, slider.value); }, 150);
      };
      // 减号按钮（步进10 PWM，约1.35°）
      var minusBtn = document.createElement('button');
      minusBtn.className = 'btn btn-ghost btn-sm jstep-btn';
      minusBtn.textContent = '−';
      minusBtn.id = 'jminus-'+sid;
      minusBtn.style.cssText = 'padding:2px 9px;flex-shrink:0;font-size:15px;font-weight:700;line-height:1';
      bindHoldButton(minusBtn, function(){ stepJoint(sid, -10); });
      // 加号按钮
      var plusBtn = document.createElement('button');
      plusBtn.className = 'btn btn-ghost btn-sm jstep-btn';
      plusBtn.textContent = '+';
      plusBtn.id = 'jplus-'+sid;
      plusBtn.style.cssText = 'padding:2px 9px;flex-shrink:0;font-size:15px;font-weight:700;line-height:1';
      bindHoldButton(plusBtn, function(){ stepJoint(sid, 10); });
      row.appendChild(name);
      row.appendChild(minusBtn);
      row.appendChild(slider);
      row.appendChild(plusBtn);
      row.appendChild(val);
      box.appendChild(row);
    })(i);
  }
}

function indMoveServo(sid, pwm){
  if(!_ind.connected) return;
  // 手动调滑块不设 busy，不禁用滑块；只有 goto/自动分拣等自动动作才禁用
  fetch('/api/arm/move', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({servo_id:sid, pwm:parseInt(pwm), duration:600})})
    .then(function(r){return r.json();})
    .then(function(res){
      if(!res.ok && res.msg) console.warn('舵机移动失败:', res.msg);
      // 外部滑块改动 -> 立即同步到编辑器滑块（编辑器打开时）
      if(_ag.open) agSetJointUI(sid, parseInt(pwm));
    })
    .catch(function(){});
}

function indPump(action){
  if(!_ind.connected) return;
  var labels = {suck:'吸气', release:'放气', off:'停止'};
  showLoading('气泵' + (labels[action]||action) + '...', 20);
  fetch('/api/arm/pump', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:action})})
    .then(function(r){return r.json();})
    .then(function(res){
      hideLoading();
      if(res.ok){
        toast(res.msg);
        _ind.pumpState = res.state || action;
        if(action === 'suck'){
          _ind.pumpRemaining = _ind.pumpTimeoutSec || 10;
          indEnsurePumpCountdown();
        } else {
          indStopPumpCountdown();
        }
        indUpdateUI();
      }
      else { toast(res.msg||'操作失败'); }
    })
    .catch(function(){ hideLoading(); toast('请求失败'); });
}

function indRenderPumpCountdown(){
  var el = document.getElementById('pump-countdown');
  if(!el) return;
  if(_ind.pumpState === 'suck'){
    var n = (_ind.pumpRemaining != null) ? _ind.pumpRemaining : (_ind.pumpTimeoutSec || 10);
    // display 用 inline：倒计时现在位于「气泵控制」标题右侧同一行内，
    // 不能用 block（会独占一行把标题挤下去）
    el.style.display = 'inline';
    el.textContent = '吸气中 · 剩余 ' + n + ' 秒自动放气';
  } else {
    el.style.display = 'none';
    el.textContent = '';
  }
}
function indTickPumpCountdown(){
  if(_ind.pumpState !== 'suck'){ indStopPumpCountdown(); return; }
  var n = (_ind.pumpRemaining == null) ? (_ind.pumpTimeoutSec || 10) : _ind.pumpRemaining;
  n = n - 1;
  if(n < 0) n = 0;
  _ind.pumpRemaining = n;
  indRenderPumpCountdown();
}
function indEnsurePumpCountdown(){
  indRenderPumpCountdown();
  if(_ind.pumpCountdownTimer) return;
  _ind.pumpCountdownTimer = setInterval(indTickPumpCountdown, 1000);
}
function indStopPumpCountdown(){
  if(_ind.pumpCountdownTimer){ clearInterval(_ind.pumpCountdownTimer); _ind.pumpCountdownTimer = null; }
  _ind.pumpRemaining = null;
  var el = document.getElementById('pump-countdown');
  if(el){ el.style.display = 'none'; el.textContent = ''; }
}

// ===== 去姿态行程模式（经原点 / 直达，全局生效） =====
function indRenderViaHome(){
  var on = document.getElementById('viahome-on-btn');
  var off = document.getElementById('viahome-off-btn');
  if(on) on.className = 'source-tab' + (_ind.viaHome ? ' active' : '');
  if(off) off.className = 'source-tab' + (_ind.viaHome ? '' : ' active');
  // 编辑器弹窗顶栏里也有一份（分段样式，与速度三档一致）
  var eon = document.getElementById('e-viahome-on-btn');
  var eoff = document.getElementById('e-viahome-off-btn');
  if(eon) eon.className = 'source-tab' + (_ind.viaHome ? ' active' : '');
  if(eoff) eoff.className = 'source-tab' + (_ind.viaHome ? '' : ' active');
}

function indSetMoveSpeed(profile){
  if(profile === _ind.moveSpeed) return;
  fetch('/api/arm/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({move_speed: profile})
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res.ok){
        _ind.moveSpeed = profile;
        indRenderMoveSpeed();
        var names = {slow:'「慢」', normal:'「标准」', fast:'「快」'};
        toast(res.msg || ('动作速度已设为' + (names[profile] || profile)));
      } else { toast(res.msg || '设置失败'); }
    })
    .catch(function(){ toast('请求失败'); });
}

function indRenderMoveSpeed(){
  var cur = _ind.moveSpeed || 'normal';
  // 兜底：后端若返回三个档位之外的值（旧数据/异常），三个按钮会全部不亮，
  // 表现为"橙色选中块消失"。这里强制回落到 standard，保证永远有一档是选中的。
  if(cur !== 'slow' && cur !== 'normal' && cur !== 'fast') cur = 'normal';
  // 外面工控页和编辑器弹窗里各有一份三档按钮，两处同步渲染
  ['slow','normal','fast'].forEach(function(p){
    ['speed-' + p + '-btn', 'espeed-' + p + '-btn'].forEach(function(id){
      var b = document.getElementById(id);
      if(b) b.className = 'source-tab' + (cur === p ? ' active' : '');
    });
  });
}

function indSetViaHome(enabled){
  fetch('/api/arm/via-home', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({enabled: !!enabled})
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res.ok){
        _ind.viaHome = !!res.via_home;
        indRenderViaHome();
        toast(res.msg || ('已设为' + (_ind.viaHome ? '「经原点」' : '「直达」')));
      } else { toast(res.msg || '设置失败'); }
    })
    .catch(function(){ toast('请求失败'); });
}

// ===== 从硬件回读真实关节位置，驱动滑块跟随 =====
// 仅在「已连接且空闲」时回读：运动中会得到中间值，且串口读写会干扰动作时序。
// 另设 3 秒手动操作保护：用户刚动过滑块时不回读，避免两边抢值。
function indMaybeReadPose(){
  if(!_ind.connected || _ind.busy) return;
  if(Date.now() - (_ind.lastJointTouch || 0) < 3000) return;
  fetch('/api/arm/pose/read')
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(!res.ok || !res.pose) return;
      // 回来时状态可能已变（开始运动/用户动过滑块），丢弃
      if(!_ind.connected || _ind.busy) return;
      if(Date.now() - (_ind.lastJointTouch || 0) < 3000) return;
      indApplyPoseToSliders(res.pose);
    })
    .catch(function(){});
}

function indApplyPoseToSliders(pose){
  for(var si=0; si<5; si++){
    var pwm = pose[si] != null ? pose[si] : pose[String(si)];
    if(pwm == null) continue;
    var sl = document.getElementById('jslider-'+si);
    var ve = document.getElementById('jval-'+si);
    // 程序化赋值不会触发 oninput，因此不会误下发指令
    if(sl) sl.value = pwm;
    if(ve) ve.textContent = pwm;
  }
  // 同步给编辑器里的滑块（编辑器打开时两边保持一致）
  agSyncJointsFromPose(pose);
}

function indRenderPoseBtns(){
  var box = document.getElementById('arm-pose-btns');
  if(!box) return;
  box.innerHTML = '';
  getPoseList().forEach(function(p){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:4px';
    var gotoBtn = document.createElement('button');
    gotoBtn.className = 'btn btn-ghost btn-sm';
    gotoBtn.style.width = '150px';
    gotoBtn.style.flex = 'none';
    gotoBtn.style.overflow = 'hidden';
    gotoBtn.style.textOverflow = 'ellipsis';
    gotoBtn.style.whiteSpace = 'nowrap';
    gotoBtn.textContent = '→ ' + p.label;
    gotoBtn.id = 'pose-goto-'+p.key;
    gotoBtn.onclick = function(){ indGotoPose(p.key); };
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-ghost btn-sm';
    // 标定前后文案均为 2 字（保存 / 更新），宽度恒定，避免页面乱跳
    saveBtn.style.flex = 'none';
    saveBtn.textContent = '保存';
    saveBtn.id = 'pose-save-'+p.key;
    saveBtn.onclick = function(){ indSavePose(p.key); };
    wrap.appendChild(gotoBtn);
    wrap.appendChild(saveBtn);
    box.appendChild(wrap);
  });
  indUpdatePoseBtns();
}

function indUpdatePoseBtns(){
  getPoseList().forEach(function(p){
    var gotoBtn = document.getElementById('pose-goto-'+p.key);
    var saveBtn = document.getElementById('pose-save-'+p.key);
    var calibrated = _ind.poses && _ind.poses[p.key] && _ind.poses[p.key].calibrated;
    if(gotoBtn){
      gotoBtn.disabled = !_ind.connected || !calibrated || _ind.busy;
      if(calibrated){
        var active = _ind.connected && !_ind.busy;
        gotoBtn.textContent = '→ ' + p.label + ' ✓';
        gotoBtn.style.opacity = active ? '1' : '0.4';
        gotoBtn.style.color = active ? '#7ec87e' : '';
        gotoBtn.style.borderColor = active ? 'rgba(126,200,126,.4)' : '';
      } else {
        gotoBtn.textContent = '→ ' + p.label + '（未标定）';
        gotoBtn.style.opacity = '0.45';
        gotoBtn.style.color = '';
        gotoBtn.style.borderColor = '';
      }
    }
    if(saveBtn){
      saveBtn.disabled = !_ind.connected || _ind.busy;
      // 已标定显示「更新」、未标定显示「保存」——同为 2 字，宽度恒定不跳动
      saveBtn.textContent = calibrated ? '更新' : '保存';
      saveBtn.title = calibrated ? '已标定，点击更新为当前姿态' : '';
      if(calibrated){
        saveBtn.style.color = '#c9986b';
        saveBtn.style.borderColor = 'rgba(201,152,107,.4)';
      } else {
        saveBtn.style.color = '';
        saveBtn.style.borderColor = '';
      }
    }
  });
}

function indSavePose(name){
  if(!_ind.connected) return;
  var label = (getPoseList().find(function(p){return p.key===name;})||{}).label || name;
  // 已标定过 -> 文案用「更新」，与按钮上的「更新」保持一致
  var calibrated = _ind.poses && _ind.poses[name] && _ind.poses[name].calibrated;
  var actWord = calibrated ? '更新' : '保存';
  confirmDialog(actWord + '姿态',
    calibrated ? ('确定将「' + label + '」更新为当前各关节位置吗？')
               : ('确定将当前各关节位置保存为「' + label + '」吗？'), function(){
    showLoading('正在' + actWord + '「' + label + '」...', 20);
    fetch('/api/arm/pose/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name})})
      .then(function(r){return r.json();})
      .then(function(res){
        hideLoading();
        if(res.ok){ toast(res.msg); indFetchStatus(); }
        else { toast(res.msg||'保存失败'); }
      })
      .catch(function(){ hideLoading(); toast('请求失败'); });
  });
}

function indGotoPose(name){
  if(!_ind.connected || _ind.busy) return;
  var label = (getPoseList().find(function(p){return p.key===name;})||{}).label || name;
  _ind.busy = true;
  indUpdateUI();
  indUpdatePoseBtns();
  showLoading('机械臂移动到「'+label+'」...', 20);
  // 不传 duration：后端按这一步的位移自动算时长（大幅给够、小幅不白等）
  fetch('/api/arm/pose/goto', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name})})
    .then(function(r){return r.json();})
    .then(function(res){
      hideLoading();
      if(res.ok){
        toast(res.msg);
        _ind.busy = false;
        indUpdateUI();
        indUpdatePoseBtns();
        var poseData = _ind.poses && _ind.poses[name] && _ind.poses[name].pose;
        if(poseData){
          for(var si=0;si<5;si++){
            var sl = document.getElementById('jslider-'+si);
            var ve = document.getElementById('jval-'+si);
            var pwm = poseData[si] != null ? poseData[si] : poseData[String(si)];
            if(pwm != null){
              if(sl) sl.value = pwm;
              if(ve) ve.textContent = pwm;
            }
          }
        }
      }
      else { toast(res.msg||'移动失败'); _ind.busy=false; indUpdateUI(); indUpdatePoseBtns(); }
    })
    .catch(function(){ hideLoading(); _ind.busy=false; indUpdateUI(); indUpdatePoseBtns(); toast('请求失败'); });
}

function indEStop(){
  if(!_ind.connected){ toast('机械臂未连接'); return; }
  // 不做二次确认：紧急停止必须一点就停
  // 后端急停要发串口指令并做放气收尾，回包有约 1 秒延迟 —— 先立即给反馈，
  // 等回包再确认（失败时补报错，成功时不重复弹）
  toast('已发送急停指令', 'err');
  fetch('/api/arm/stop', {method:'POST'}).then(function(r){return r.json();}).then(function(res){
    if(res && res.ok === false){ toast(res.msg || '急停失败', 'err'); }
    indFetchStatus();
  }).catch(function(){ toast('急停请求失败', 'err'); });
}

// ===== 摄像头与推理（getUserMedia + POST detect/frame） =====
_ind.webcamStream = null;
_ind.webcamTimer = null;
_ind.webcamBusy = false;
_ind.webcamCanvas = document.createElement('canvas');

function showModelClasses(mid){
  var m = (state.models || []).find(function(x){ return x.id === mid; });
  if(!m) return;
  var list = m.classes || m.tags || [];
  var titleEl = document.getElementById('mc-modal-title');
  var body = document.getElementById('mc-modal-body');
  if(titleEl) titleEl.textContent = '「' + (m.name || m.file_name) + '」的类别（' + list.length + ' 类）';
  if(!body) return;
  body.innerHTML = '';
  if(!list.length){
    body.innerHTML = '<p style="color:var(--text-3);font-size:13px;margin:0">暂无类别信息（该模型的元信息尚未回填，可在模型管理点"刷新元信息"）</p>';
  } else {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
    list.forEach(function(c){
      var t = document.createElement('span');
      t.style.cssText = 'font-size:12px;padding:3px 10px;border-radius:10px;' +
        'background:rgba(201,152,107,.15);color:var(--accent);border:1px solid rgba(201,152,107,.3)';
      t.textContent = c;
      wrap.appendChild(t);
    });
    body.appendChild(wrap);
  }
  openModal('model-classes-modal');
}

function indLoadCurrentModel(){
  // ① 先用轻量接口把"模型名"立刻显示出来（只查库，不触发模型加载）。
  //    此前要等下面的 /api/models/current（需加载模型拿类别名）才显示，
  //    冷启动/刚重启时会空白 1~2 秒。
  fetch('/api/models/current-name').then(function(r){return r.json();}).then(function(res){
    if(res.ok && res.name){
      var nEl = document.getElementById('ind-cur-model-name');
      if(nEl) nEl.textContent = res.name;
      _ind.curModel = res.name;
    }
  }).catch(function(){});
  // ② 再取完整信息（含类别名，需加载模型，冷启动可能慢 1~2 秒）
  fetch('/api/models/current').then(function(r){return r.json();}).then(function(res){
    if(res.ok && res.model){
      var nameEl = document.getElementById('ind-cur-model-name');
      var subEl = document.getElementById('ind-cur-model-sub');
      var name = res.model.name || res.model.file_name || '--';
      if(nameEl) nameEl.textContent = name;
      if(subEl) subEl.textContent = res.model.description || '当前推理模型';
      _ind.curModel = name;
      _ind.modelClasses = res.model.classes || [];
      indRenderClasses();
      indRefreshClassFilter();
      indLoadSortStats();
    }
  }).catch(function(){});
}

// ===== 检测源类型：cam=USB摄像头 / file=本地视频文件 / stream=网络流 / screen=屏幕捕获 =====
// 四种源最终都汇进同一条推理链路：画面（video 或 MJPEG img）-> canvas 抓帧 -> /api/detect/frame
_ind.srcType = 'cam';
_ind.fileURL = null;

var _IND_SRC_LABELS = {cam:'开启摄像头', file:'播放视频', stream:'连接网络流', screen:'选择屏幕/窗口'};
function indOnSrcTypeChange(){
  if(_ind.cameraOn){ indStopCamera(true); }
  _ind.srcType = document.getElementById('ind-src-type').value;
  document.getElementById('ind-cam-device').style.display = (_ind.srcType === 'cam') ? '' : 'none';
  document.getElementById('ind-file-btn').style.display = (_ind.srcType === 'file') ? '' : 'none';
  document.getElementById('ind-stream-url').style.display = (_ind.srcType === 'stream') ? '' : 'none';
  document.getElementById('ind-cam-start').textContent = _IND_SRC_LABELS[_ind.srcType] || '开启';
}

function indStartSource(){
  if(_ind.srcType === 'file') return indStartFile();
  if(_ind.srcType === 'stream') return indStartNetStream();
  if(_ind.srcType === 'screen') return indStartScreen();
  return indStartCamera();
}

// 源画面就绪后的公共收尾：显隐切换 / ROI 叠加 / 预览定时器 / 按钮状态
function indAfterSourceReady(){
  _ind.cameraOn = true;
  _ind.inferOn = false;
  indInvalidateTrigger();   // 换源/重开画面：防抖累计+仲裁窗全部失效
  var video = document.getElementById('ind-cam-video');
  var live = document.getElementById('ind-cam-live');
  var ph = document.getElementById('ind-cam-placeholder');
  var badge = document.getElementById('ind-cam-badge');
  if(_ind.srcType === 'stream'){
    if(video) video.style.display = 'none';
    if(live) live.style.display = 'block';
  } else {
    if(video) video.style.display = 'block';
    if(live) live.style.display = 'none';
  }
  if(ph) ph.style.display = 'none';
  if(badge) badge.style.display = 'block';
  var meta0 = document.querySelector('#ind-cam-box .cam-meta');
  if(meta0) meta0.style.display = '';
  indShowRoiOverlay(true);
  indRenderRoi();   // 重开画面源后把已保存的识别区域框画回来
  if(_ind.webcamTimer) clearInterval(_ind.webcamTimer);
  _ind.webcamTimer = setInterval(indCaptureFrame, 500);
  indUpdateCamUI();
}

// --- 源②：本地视频文件（循环回放，适合复现现场/离线验证模型） ---
function indOnFilePicked(input){
  var f = input.files && input.files[0];
  if(!f) return;
  // 关键顺序：**先停止上一个视频，再撤销旧 URL**。
  // 反过来（先 revoke 正在播放的 blob URL）会让 video 直接报错 -> 被误判成"无法解码/播放失败"。
  if(_ind.cameraOn) indStopCamera(true);
  if(_ind.fileURL){ try{ URL.revokeObjectURL(_ind.fileURL); }catch(e){} }
  _ind.fileURL = null;
  _ind.fileURL = URL.createObjectURL(f);
  var btn = document.getElementById('ind-file-btn');
  if(btn) btn.textContent = f.name;
  indStartFile();   // 选完即播，少一次点击
}

function indStartFile(){
  if(!_ind.fileURL){ toast('请先点击「选择视频文件…」选择要回放的视频'); return; }
  if(_ind.cameraOn) indStopCamera(true);
  var video = document.getElementById('ind-cam-video');
  if(!video){ toast('画面组件缺失'); return; }
  video.srcObject = null;
  video.loop = true;
  video.muted = true;
  video.src = _ind.fileURL;
  video.onloadedmetadata = function(){
    _ind.srcW = video.videoWidth; _ind.srcH = video.videoHeight;
    var vw = video.videoWidth, vh = video.videoHeight;
    _ind.frameW = 640;
    _ind.frameH = vh ? Math.round(640 * vh / vw) : 480;
    indSyncRoiOverlay(); indRenderRoi();
    indUpdateResText(640, _ind.frameH);
  };
  video.onerror = function(){
    toast('该视频无法在浏览器中解码（建议改用 MP4/H.264 格式）');
    indStopCamera(true);
  };
  video.play().then(function(){
    indAfterSourceReady();
    toast('视频循环回放中，可点「开启推理」');
  }).catch(function(err){
    // 连续换视频时，旧播放请求会被新加载打断（AbortError）——这是正常流程，不该报错
    if(err && err.name === 'AbortError') return;
    toast('无法播放视频：' + (err.message || '浏览器阻止了自动播放'));
  });
}

// --- 源③：网络流 IP摄像头（后端中继 MJPEG，前端照常抓帧推理） ---
function indStartNetStream(){
  var url = ((document.getElementById('ind-stream-url')||{}).value || '').trim();
  if(!url){ toast('请先填写流地址或本地视频文件路径'); return; }
  if(_ind.cameraOn) indStopCamera(true);
  showLoading('正在连接网络流…', 100);
  api('/api/ind/stream/open', {method:'POST', body: JSON.stringify({url: url})})
    .then(function(res){
      hideLoading();
      if(!res.data.ok){ toast(res.data.msg || '连接失败'); return; }
      var live = document.getElementById('ind-cam-live');
      live.onerror = function(){
        live.style.display = 'none';
        var ph = document.getElementById('ind-cam-placeholder');
        if(ph){ ph.style.display = 'flex'; ph.textContent = '网络流中断，请检查地址后重新连接'; }
      };
      live.onload = function(){
        var ph = document.getElementById('ind-cam-placeholder');
        if(ph){ ph.style.display = 'none'; }
        if(live.naturalWidth){
          _ind.frameW = 640;
          _ind.frameH = Math.round(640 * live.naturalHeight / live.naturalWidth);
          _ind.srcW = live.naturalWidth; _ind.srcH = live.naturalHeight;
          indSyncRoiOverlay(); indRenderRoi();
          indUpdateResText(640, _ind.frameH);
        }
      };
      live.src = '/api/ind/stream/mjpeg?t=' + Date.now();
      indAfterSourceReady();
      // 后端兜底下载是阻塞的，可能要下满 2GB 才判定失败；持续轮询状态：
      // 下载中显示「正在连接/缓冲视频流…」，失败/超限显示真实原因，出帧即停止。
      var _pollGuard = 0;
      var _pollTimer = setInterval(function(){
        if(!_ind.cameraOn || _ind.srcType !== 'stream'){ clearInterval(_pollTimer); return; }
        api('/api/ind/stream/status').then(function(r){
          var d = r.data || {};
          var ph = document.getElementById('ind-cam-placeholder');
          if(d.has_frame){ clearInterval(_pollTimer); if(ph){ ph.style.display = 'none'; } return; }
          if(d.error){ clearInterval(_pollTimer); if(ph){ ph.style.display = 'flex'; ph.textContent = d.error; } return; }
          if(d.running){ if(ph){ ph.style.display = 'flex'; ph.textContent = '正在连接/缓冲视频流…'; } }
          if(++_pollGuard > 90){ clearInterval(_pollTimer); }   // 约 3 分钟无进展也停轮询
        }).catch(function(){ if(++_pollGuard > 90){ clearInterval(_pollTimer); } });
      }, 2000);
      toast('网络流已连接，可点「开启推理」');
    })
    .catch(function(){ hideLoading(); toast('连接请求失败'); });
}

// --- 源④：屏幕/窗口捕获（演示投屏；需 localhost/HTTPS 安全环境） ---
function indStartScreen(){
  if(!window.isSecureContext){
    toast('屏幕捕获需要安全环境：请用 http://127.0.0.1:5000 访问本页');
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    toast('当前浏览器不支持屏幕捕获'); return;
  }
  if(_ind.cameraOn) indStopCamera(true);
  // 屏幕可能是 2K/4K，与摄像头同理加 1080p 上限：省编码与缩放开销（预览够用即可）
  navigator.mediaDevices.getDisplayMedia({
    video:{width:{ideal:3840}, height:{ideal:2160}, frameRate:{ideal:15}}, audio:false
  })
    .then(function(stream){
      _ind.webcamStream = stream;   // 复用同一引用：关闭时统一 stop 轨道
      var video = document.getElementById('ind-cam-video');
      video.srcObject = stream;
      video.onloadedmetadata = function(){
        _ind.srcW = video.videoWidth; _ind.srcH = video.videoHeight;
        var vw = video.videoWidth, vh = video.videoHeight;
        _ind.frameW = 640;
        _ind.frameH = vh ? Math.round(640 * vh / vw) : 480;
        indSyncRoiOverlay(); indRenderRoi();
        indUpdateResText(640, _ind.frameH);
      };
      // 用户在浏览器弹条里点"停止共享"时，自动走完整关闭流程
      var track = stream.getVideoTracks()[0];
      if(track) track.onended = function(){
        if(_ind.srcType === 'screen' && _ind.cameraOn) indStopCamera();
      };
      video.play().then(function(){
        indAfterSourceReady();
        toast('屏幕捕获中，可点「开启推理」');
      });
    })
    .catch(function(err){
      if(err && err.name === 'NotAllowedError'){ toast('已取消屏幕选择'); return; }
      toast('屏幕捕获失败：' + ((err && err.message) || err));
    });
}

function indUpdateCamUI(){  var startBtn = document.getElementById('ind-cam-start');
  var stopBtn = document.getElementById('ind-cam-stop');
  var inferStart = document.getElementById('ind-infer-start');
  var inferStop = document.getElementById('ind-infer-stop');
  var camDot = document.getElementById('ind-cam-dot');
  var camVal = document.getElementById('ind-cam-val');
  if(startBtn) startBtn.style.display = _ind.cameraOn ? 'none' : '';
  if(stopBtn) stopBtn.style.display = _ind.cameraOn ? '' : 'none';
  if(inferStart) inferStart.style.display = (_ind.cameraOn && !_ind.inferOn) ? '' : 'none';
  if(inferStop) inferStop.style.display = (_ind.cameraOn && _ind.inferOn) ? '' : 'none';
  if(camDot) camDot.className = 'ind-status-dot ' + (_ind.cameraOn ? 'on' : 'off');
  if(camVal) camVal.textContent = _ind.cameraOn ? (_ind.inferOn ? '推理中' : '预览中') : '未开启';
}

function indRefreshCamDevices(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  navigator.mediaDevices.enumerateDevices().then(function(devices){
    var cams = devices.filter(function(d){return d.kind==='videoinput';});
    var sel = document.getElementById('ind-cam-device');
    if(!sel) return;
    var cur = sel.value;
    sel.innerHTML = '';
    if(!cams.length){
      var opt0 = document.createElement('option');
      opt0.value = ''; opt0.textContent = '默认摄像头';
      sel.appendChild(opt0);
      return;
    }
    cams.forEach(function(d, i){
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      var label = d.label || ('摄像头 ' + (i+1));
      opt.textContent = label;
      opt.title = label;
      sel.appendChild(opt);
    });
    if(cur) sel.value = cur;
  }).catch(function(){});
}

function indOnCamDeviceChange(){
  if(_ind.cameraOn && _ind.webcamStream){
    var wasInferring = _ind.inferOn;
    if(_ind.webcamTimer){ clearInterval(_ind.webcamTimer); _ind.webcamTimer = null; }
    _ind.webcamStream.getTracks().forEach(function(t){t.stop();});
    _ind.webcamStream = null;
    _ind.webcamBusy = false;
    var devId = (document.getElementById('ind-cam-device')||{}).value || '';
    var videoConstraints = devId
      ? {deviceId:{exact:devId}, width:{ideal:3840}, height:{ideal:2160}}
      : {width:{ideal:3840}, height:{ideal:2160}};
    navigator.mediaDevices.getUserMedia({video:videoConstraints, audio:false})
      .then(function(stream){
        _ind.webcamStream = stream;
        _ind.cameraOn = true;
        var video = document.getElementById('ind-cam-video');
        var img = document.getElementById('ind-cam-img');
        video.srcObject = stream;
        // 视频元数据就绪才知道真实分辨率 -> 据此同步 ROI 叠加层尺寸
        video.onloadedmetadata = function(){
          _ind.srcW = video.videoWidth; _ind.srcH = video.videoHeight;
          var vw = video.videoWidth, vh = video.videoHeight;
          if(vw && vh){ _ind.frameW = 640; _ind.frameH = Math.round(vh * 640 / vw); }
          indSyncRoiOverlay(); indRenderRoi();
          indUpdateResText(640, _ind.frameH);
        };
        video.style.display = 'block';
        img.style.display = 'none';
        indShowRoiOverlay(true);
        indRenderRoi();   // 重开摄像头后把已保存的识别区域框画回来
        video.play().then(function(){
          if(wasInferring){
            _ind.inferOn = true;
            _ind.fpsEma = null; _ind.fpsPrevTs = 0; _ind.fpsShownTs = 0;   // 重置 FPS 滑动平均
            indCaptureFrame();
          } else {
            _ind.webcamTimer = setInterval(indCaptureFrame, 500);
          }
        });
        indUpdateCamUI();
        toast('已切换摄像头');
      })
      .catch(function(err){
        toast('切换失败：' + (err.message || '无法访问'));
        // 完整清理画面，恢复占位状态
        if(_ind.webcamTimer){ clearInterval(_ind.webcamTimer); _ind.webcamTimer = null; }
        if(_ind.webcamStream){ _ind.webcamStream.getTracks().forEach(function(t){t.stop();}); _ind.webcamStream = null; }
        _ind.cameraOn = false;
        _ind.inferOn = false;
        indInvalidateTrigger();
        _ind.webcamBusy = false;
        var v = document.getElementById('ind-cam-video');
        var im = document.getElementById('ind-cam-img');
        var ph = document.getElementById('ind-cam-placeholder');
        var badge = document.getElementById('ind-cam-badge');
        var meta = document.querySelector('#ind-cam-box .cam-meta');
        if(v){ v.pause(); v.srcObject = null; v.style.display='none'; }
        indShowRoiOverlay(false);
        indClearBoxes();
        if(im){ im.src=''; im.style.display='none'; }
        if(ph) ph.style.display = 'flex';
        if(badge) badge.style.display = 'none';
        if(meta) meta.style.display = 'none';
        var _dbx = document.getElementById('ind-detect-boxes');
        if(_dbx) _dbx.innerHTML = '<span style="color:var(--text-3)">开启摄像头推理后显示检测类别和数量</span>';
        var fpsEl = document.getElementById('ind-fps');
        if(fpsEl) fpsEl.textContent = 'FPS: --';   // 卡片内的 FPS 会随卡片重建自动清空
        indUpdateCamUI();
      });
  }
}

function indStartCamera(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast('当前浏览器不支持摄像头调用（需 HTTPS 或 localhost）');
    return;
  }
  if(_ind.webcamStream){ indStopCamera(true); }
  indRefreshCamDevices();
  var devId = (document.getElementById('ind-cam-device')||{}).value || '';
  var videoConstraints = devId
    ? {deviceId:{exact:devId}, width:{ideal:3840}, height:{ideal:2160}}
    : {width:{ideal:3840}, height:{ideal:2160}};
  navigator.mediaDevices.getUserMedia({video:videoConstraints, audio:false})
    .then(function(stream){
      _ind.webcamStream = stream;
      _ind.cameraOn = true;
      _ind.inferOn = false;
      indInvalidateTrigger();   // 新摄像头：旧画面期间的累计/窗口全部失效
      var video = document.getElementById('ind-cam-video');
      var img = document.getElementById('ind-cam-img');
      var ph = document.getElementById('ind-cam-placeholder');
      var badge = document.getElementById('ind-cam-badge');
      video.srcObject = stream;
      // 视频元数据就绪才知道真实分辨率 -> 据此同步 ROI 叠加层尺寸
      video.onloadedmetadata = function(){
        _ind.srcW = video.videoWidth; _ind.srcH = video.videoHeight;
        var vw = video.videoWidth, vh = video.videoHeight;
        if(vw && vh){ _ind.frameW = 640; _ind.frameH = Math.round(vh * 640 / vw); }
        indSyncRoiOverlay(); indRenderRoi();
      };
      indShowRoiOverlay(true);
      indRenderRoi();   // 重开摄像头后把已保存的识别区域框画回来
      video.style.display = 'block';
      img.style.display = 'none';
      ph.style.display = 'none';
      badge.style.display = 'block';
      var meta0 = document.querySelector('#ind-cam-box .cam-meta');
      if(meta0) meta0.style.display = '';
      video.play().then(function(){
        // 预览模式：500ms 更新一次分辨率即可
        _ind.webcamTimer = setInterval(indCaptureFrame, 500);
      });
      indUpdateCamUI();
      indRefreshCamDevices();
      indLoadCurrentModel();
      toast('摄像头已开启');
    })
    .catch(function(err){
      console.error(err);
      toast('无法访问摄像头：' + (err.message || '权限被拒绝'));
    });
}

function indStopCamera(silent){
  if(_ind.webcamTimer){ clearInterval(_ind.webcamTimer); _ind.webcamTimer = null; }
  // 按源类型释放资源（webcamStream 轨道的停止在下方公共段，cam/screen 共用）
  if(_ind.srcType === 'stream'){
    var liveEl = document.getElementById('ind-cam-live');
    if(liveEl){ liveEl.onload = null; liveEl.onerror = null; liveEl.src = ''; liveEl.style.display = 'none'; }
    fetch('/api/ind/stream/close', {method:'POST'}).catch(function(){});
  } else if(_ind.srcType === 'file' && _ind.fileURL){
    try{ URL.revokeObjectURL(_ind.fileURL); }catch(e){}
    _ind.fileURL = null;
    var fb = document.getElementById('ind-file-btn');
    if(fb) fb.textContent = '选择视频文件…';
  }
  if(_ind.webcamStream){ _ind.webcamStream.getTracks().forEach(function(t){t.stop();}); _ind.webcamStream = null; }
  _ind.cameraOn = false;
  _ind.inferOn = false;
  indInvalidateTrigger();   // 关闭画面：防抖累计+仲裁窗全部失效（不补触发）
  var video = document.getElementById('ind-cam-video');
  var img = document.getElementById('ind-cam-img');
  var ph = document.getElementById('ind-cam-placeholder');
  var badge = document.getElementById('ind-cam-badge');
  if(video){
    video.pause();
    video.srcObject = null;
    video.loop = false;
    if(_ind.srcType === 'file'){ video.removeAttribute('src'); video.load(); }  // 文件源必须显式卸载，否则继续解码
    video.style.display = 'none';
  }
  if(img){ img.src=''; img.style.display='none'; img.style.position=''; img.style.left=''; img.style.top=''; img.style.width='100%'; img.style.height='100%'; img.style.objectFit='contain'; }
  indClearBoxes();            // 关闭画面源：清掉 canvas 上的检测框
  indShowRoiOverlay(false);   // 关摄像头后虚线框必须消失
  if(ph){ ph.style.display = 'flex'; ph.textContent = '在下方选择检测源并开启'; }
  if(badge) badge.style.display = 'none';
  var _dbx2 = document.getElementById('ind-detect-boxes');
  if(_dbx2) _dbx2.innerHTML = '<span style="color:var(--text-3)">开启摄像头推理后显示检测类别和数量</span>';
  var meta = document.querySelector('#ind-cam-box .cam-meta');
  if(meta) meta.style.display = 'none';
  indUpdateCamUI();
  // 关闭画面源时优雅停止分拣（完成当前一轮）
  if(_ind.sorterRunning){
    fetch('/api/sorter/stop', {method:'POST'}).catch(function(){});
    _ind.sorterRunning = false;
    indUpdateSorterBtn();
  }
  // 提示按当前检测源给，避免视频/网络流/屏幕源也报"已关闭摄像头"
  if(!silent){
    toast({cam:'已关闭摄像头', file:'已停止视频回放',
           stream:'已断开网络流', screen:'已停止屏幕捕获'}[_ind.srcType] || '已关闭');
  }
}
// 离开页面时清除模型定时器（go() 中会调用 indStopCamera(true)）

function indStartInfer(){
  if(!_ind.cameraOn){ toast('请先开启摄像头'); return; }
  // 先预热模型：首帧推理要"读盘 + 载入显存 + CUDA 初始化"，可能卡好几秒且毫无反馈。
  // 这里把它挪到有「正在加载模型」提示的阶段，加载完再开始逐帧推理。
  showLoading('正在加载模型…', 60);
  fetch('/api/detect/warmup', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
    .then(function(r){ return r.json(); })
    .then(function(res){
      hideLoading();
      if(!res.ok){ toast(res.msg || '模型加载失败，无法开启推理'); return; }
      _ind.inferOn = true;
      indUpdateCamUI();
      // 停止预览 interval，改为链式触发（推理完立即下一帧）
      if(_ind.webcamTimer){ clearInterval(_ind.webcamTimer); _ind.webcamTimer = null; }
      _ind.fpsEma = null; _ind.fpsPrevTs = 0; _ind.fpsShownTs = 0;   // 重置 FPS 滑动平均
      indCaptureFrame();
      toast('推理已开启');
    })
    .catch(function(){
      hideLoading();
      toast('模型预热请求失败');
    });
}

function indStopInfer(){
  _ind.inferOn = false;
  indInvalidateTrigger();   // 停止推理：防抖累计+仲裁窗全部失效（不补触发）
  indClearBoxes();   // 停止推理后清掉叠加的框（底层画面继续流畅播放）
  var _dbx4 = document.getElementById('ind-detect-boxes');
  if(_dbx4) _dbx4.innerHTML = '<span style="color:var(--text-3)">开启摄像头推理后显示检测类别和数量</span>';
  // 切回预览画面（网络流模式的底层是 MJPEG <img>，其余源是 <video>）
  var video = document.getElementById('ind-cam-video');
  var live = document.getElementById('ind-cam-live');
  var img = document.getElementById('ind-cam-img');
  if(_ind.srcType === 'stream'){
    if(live) live.style.display = 'block';
    if(video) video.style.display = 'none';
  } else {
    if(video) video.style.display = 'block';
  }
  if(img) img.style.display = 'none';
  // 恢复预览 interval
  if(!_ind.webcamTimer && _ind.cameraOn){
    _ind.webcamTimer = setInterval(indCaptureFrame, 500);
  }
  var fpsEl = document.getElementById('ind-fps');
  if(fpsEl) fpsEl.textContent = 'FPS: --';   // 卡片内的 FPS 会随卡片重建自动清空
  indUpdateCamUI();
}

// ===== 识别区域（ROI）：框选的区域才送模型推理 =====
// _ind.roi = null（全画面）或 {x,y,w,h}（640x480 帧坐标）
_ind.roi = null;
var _roiMode = null, _roiStart = null;

// 实际帧尺寸（抓帧时写入）。摄像头 16:9 时是 640x360，4:3 时是 640x480。
function indFrameW(){ return _ind.frameW || 640; }
function indFrameH(){ return _ind.frameH || 480; }

// 叠加层对齐**视频实际显示区域**：画面框是 16:10 而视频可能是 16:9，
// contain 会留黑边；若叠加层铺满整个框（含黑边），坐标换算就会偏 -> 选区变形。
function indSyncRoiOverlay(){
  var box = document.getElementById('ind-cam-box');
  var o = document.getElementById('ind-roi-overlay');
  if(!box || !o) return;
  var bw = box.clientWidth, bh = box.clientHeight;
  var fw = indFrameW(), fh = indFrameH();
  if(!bw || !bh || !fw || !fh) return;
  var sc = Math.min(bw / fw, bh / fh);      // object-fit: contain
  var dw = Math.round(fw * sc), dh = Math.round(fh * sc);
  o.style.left = Math.round((bw - dw) / 2) + 'px';
  o.style.top = Math.round((bh - dh) / 2) + 'px';
  o.style.width = dw + 'px';
  o.style.height = dh + 'px';
  // 清掉 inset:0 留下的 right/bottom，否则与上面的宽高冲突
  o.style.right = 'auto';
  o.style.bottom = 'auto';
}

function indShowRoiOverlay(show){
  var o = document.getElementById('ind-roi-overlay');
  if(o) o.style.display = show ? 'block' : 'none';
}

// 校正旧 ROI：早期版本按 640x480 换算，摄像头为 16:9(640x360) 时旧值会越界，
// 导致结果图显示在错误位置/看不见检测框。这里把它钳回当前帧尺寸内。
function indClampRoi(){
  var roi = _ind.roi;
  if(!roi) return;
  var fw = indFrameW(), fh = indFrameH();
  roi.w = Math.max(20, Math.min(fw, roi.w));
  roi.h = Math.max(20, Math.min(fh, roi.h));
  roi.x = Math.max(0, Math.min(fw - roi.w, roi.x));
  roi.y = Math.max(0, Math.min(fh - roi.h, roi.y));
}

function indRenderRoi(){
  var r = document.getElementById('ind-roi-rect');
  var h = document.getElementById('ind-roi-handle');
  if(!r || !h) return;
  var roi = _ind.roi;
  if(!roi){ r.style.display = 'none'; h.style.display = 'none'; return; }
  indClampRoi();
  r.style.display = 'block';
  r.style.left = (roi.x / indFrameW() * 100) + '%';
  r.style.top = (roi.y / indFrameH() * 100) + '%';
  r.style.width = (roi.w / indFrameW() * 100) + '%';
  r.style.height = (roi.h / indFrameH() * 100) + '%';
  h.style.display = 'block';
  h.style.left = 'calc(' + ((roi.x + roi.w) / indFrameW() * 100) + '% - 5px)';
  h.style.top = 'calc(' + ((roi.y + roi.h) / indFrameH() * 100) + '% - 5px)';
}

// 鼠标 -> 帧坐标（640x480）
function indRoiFramePos(e){
  var o = document.getElementById('ind-roi-overlay');
  if(!o) return null;
  var r = o.getBoundingClientRect();
  if(!r.width || !r.height) return null;
  var x = Math.round((e.clientX - r.left) / r.width * indFrameW());
  var y = Math.round((e.clientY - r.top) / r.height * indFrameH());
  return {x: Math.max(0, Math.min(indFrameW(), x)), y: Math.max(0, Math.min(indFrameH(), y))};
}

// 新建选区的拖动阈值（帧坐标）：只点一下不拖 -> 不生成选区（否则会误触出个小框）
var _ROI_DRAG_MIN = 8;

function indRoiMouseDown(e){
  if(!_ind.cameraOn) return;
  var pos = indRoiFramePos(e);
  if(!pos) return;
  e.preventDefault(); e.stopPropagation();
  var handle = document.getElementById('ind-roi-handle');
  var rect = document.getElementById('ind-roi-rect');
  var onHandle = handle && e.target === handle;
  var onRect = rect && e.target === rect && _ind.roi;
  if(onHandle){
    _roiMode = 'resize';
    _roiStart = {roi: JSON.parse(JSON.stringify(_ind.roi))};
  } else if(onRect){
    _roiMode = 'move';       // 框内拖动 = 平移识别区域
    _roiStart = {mx: pos.x, my: pos.y, roi: JSON.parse(JSON.stringify(_ind.roi))};
  } else {
    // 空白处按下：先记为"待框选"，等真的拖动超过阈值才开始（单击不产生选区）
    _roiMode = 'pre-new';
    _roiStart = {x: pos.x, y: pos.y, prev: _ind.roi ? JSON.parse(JSON.stringify(_ind.roi)) : null};
  }
}

document.addEventListener('mousemove', function(e){
  if(!_roiMode) return;
  var pos = indRoiFramePos(e);
  if(!pos) return;
  if(_roiMode === 'pre-new'){
    // 位移超过阈值才真正进入框选：避免单击/手抖误建一个小框
    if(Math.abs(pos.x - _roiStart.x) < _ROI_DRAG_MIN && Math.abs(pos.y - _roiStart.y) < _ROI_DRAG_MIN){
      return;
    }
    _roiMode = 'new';
    indRenderRoi();
  }
  if(_roiMode === 'new'){
    _ind.roi = {
      x: Math.min(_roiStart.x, pos.x), y: Math.min(_roiStart.y, pos.y),
      w: Math.abs(pos.x - _roiStart.x), h: Math.abs(pos.y - _roiStart.y)
    };
  } else if(_roiMode === 'move'){
    var r = _roiStart.roi;
    _ind.roi = {
      x: Math.max(0, Math.min(indFrameW() - r.w, r.x + (pos.x - _roiStart.mx))),
      y: Math.max(0, Math.min(indFrameH() - r.h, r.y + (pos.y - _roiStart.my))),
      w: r.w, h: r.h
    };
  } else if(_roiMode === 'resize'){
    var r0 = _roiStart.roi;
    _ind.roi = {
      x: r0.x, y: r0.y,
      w: Math.max(20, Math.min(indFrameW() - r0.x, pos.x - r0.x)),
      h: Math.max(20, Math.min(indFrameH() - r0.y, pos.y - r0.y))
    };
  }
  indRenderRoi();
});

document.addEventListener('mouseup', function(){
  // 只按了一下没拖动（仍在 pre-new）：保持原有选区不变，清掉本次点击
  if(_roiMode === 'pre-new'){
    _ind.roi = _roiStart && _roiStart.prev ? _roiStart.prev : null;
    indRenderRoi();
  }
  _roiMode = null; _roiStart = null;
});
window.addEventListener('resize', function(){ indSyncRoiOverlay(); });

// overlay 事件绑定 + 双击重置为全画面
(function(){
  var o = document.getElementById('ind-roi-overlay');
  if(!o) return;
  o.addEventListener('mousedown', indRoiMouseDown);
  o.addEventListener('dblclick', function(){
    _ind.roi = null;
    indRenderRoi();
    toast('识别区域已重置为全画面');
  });
})();

// ===== 抓帧上传（含 ROI 裁剪）=====
function indCaptureFrame(){
  if(!_ind.cameraOn || !_ind.inferOn) return;
  if(_ind.webcamBusy){
    // 上一帧还在处理，等 50ms 再试（不断链）
    setTimeout(indCaptureFrame, 50);
    return;
  }
  // 统一取源画面：视频类（摄像头/文件/屏幕）走 <video>，网络流走 MJPEG <img>
  var video = document.getElementById('ind-cam-video');
  var live = document.getElementById('ind-cam-live');
  var srcEl = null, w = 0, h = 0;
  if(_ind.srcType === 'stream'){
    if(live && live.complete && live.naturalWidth && live.style.display !== 'none'){
      srcEl = live; w = live.naturalWidth; h = live.naturalHeight;
    }
  } else if(video && video.readyState >= 2 && video.videoWidth){
    srcEl = video; w = video.videoWidth; h = video.videoHeight;
  }
  if(!srcEl || !w || !h){
    // 画面未就绪，等 100ms 再试（不断链）
    setTimeout(indCaptureFrame, 100);
    return;
  }
  var targetW = 640, scale = targetW / w, targetH = Math.round(h * scale);
  // 记录实际帧尺寸：不同源的宽高比可能完全不同（16:9 / 16:10 / 竖屏），
  // ROI 的所有坐标换算必须以实际尺寸为基准，硬编码 480 会导致选区放大/变形
  if(_ind.frameW !== targetW || _ind.frameH !== targetH){
    _ind.frameW = targetW; _ind.frameH = targetH;
    indSyncRoiOverlay();   // 分辨率变了：重新对齐叠加层
  }
  var canvas = _ind.webcamCanvas;
  canvas.width = targetW; canvas.height = targetH;
  canvas.getContext('2d').drawImage(srcEl, 0, 0, targetW, targetH);
  // 识别区域（ROI）：只把用户框选的部分送模型，其余不上传
  var out = canvas;
  var roi = _ind.roi;
  if(roi && roi.w >= 20 && roi.h >= 20){
    // 复用同一个裁剪画布：原先每帧 createElement('canvas')，高频抓帧下
    // 反复创建/销毁大画布 -> 明显卡顿
    if(!_ind.roiCanvas) _ind.roiCanvas = document.createElement('canvas');
    out = _ind.roiCanvas;
    var rw = Math.round(roi.w), rh = Math.round(roi.h);
    if(out.width !== rw || out.height !== rh){
      out.width = rw; out.height = rh;   // 改尺寸会顺带清空画布
    }
    out.getContext('2d').drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, rw, rh);
  }
  out.toBlob(function(blob){
    if(!blob){
      // toBlob 失败，等 100ms 重试（不断链）
      setTimeout(indCaptureFrame, 100);
      return;
    }
    _ind.webcamBusy = true;
    _ind.captureTs = performance.now();   // 记录抓帧时刻，用于算框的延迟与平滑时长
    var fd = new FormData();
    fd.append('frame', blob, 'frame.jpg');
    // 置信度阈值：工控页视频框旁的输入框（与检测页同款校验，非法值回落默认）
    fd.append('conf', readConfValue('ind-conf-value'));
    // 不要后端的标注图：框由前端 canvas 画，省掉绘图/编码/base64（约 70KB 每帧）
    fd.append('want_frame', '0');
    fetch('/api/detect/frame', {method:'POST', body:fd, credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!_ind.cameraOn || !_ind.inferOn) return;
        if(d.ok){
          // 检测框改由前端 canvas 绘制：底层画面（视频/MJPEG）保持原生帧率流畅播放，
          // 不再用后端返回的整张标注图覆盖画面（那是观感卡顿的根因）。
          // ROI 模式下后端收到的是裁剪图，坐标需加 ROI 偏移还原到整帧坐标。
          var roi = _ind.roi;
          var roiUsed = (roi && roi.w >= 20 && roi.h >= 20) ? roi : null;
          // 实测本次"抓帧→出结果"的延迟，作为框的平滑过渡时长（框落后画面多少就补多少）
          if(_ind.captureTs){ _ind.lastLatency = performance.now() - _ind.captureTs; }
          indShowBoxesSmooth(d.boxes, roiUsed);
          indRenderDetectStatsThrottled(d.stats, d.total, d.duration_ms);
          // 自动分拣：先按「有映射 + 已选类别」筛出候选，再按当前规则模式挑选唯一执行对象
          //   basic  普通规则：置信度最高 → 并列比数量 → 再并列随机
          //   advanced 高级规则：四道检查（资格→规则→优先级分组[同级置信度决胜]→兜底）
          if(_ind.sorterRunning && !_ind.sorterBusy && d.class_conf && Object.keys(d.class_conf).length){
            // ⚠ 这里的「是否高级」指**机械臂行程模式**（普通分拣 / 高级动作组），
            // 决定筛候选用哪份映射：高级→类别→动作组(_ag.classGroupMap)，
            // 普通→类别→放置位(_ind.classMap)。必须与后端 _arm_mode() 同源
            // （_ag.mode 由 /api/arm/status 每轮轮询同步，agIsAdvanced() 即真实状态），
            // 否则会「前端按组映射提名、后端却按区域映射动作」错位。
            // 注意：这与下方第 4049 行的 basic/advanced **挑选规则**是两回事 ——
            // 那个只决定*怎么挑*（置信度最高 / 优先级分组），由 _ind.triggerMode 控制。
            var isAdv = agIsAdvanced();
            var sortMap = isAdv ? (_ag.classGroupMap || {}) : (_ind.classMap || {});
            var selSet = _ind.selectedClasses || [];
            // 第一道（两种模式共用）：资格门槛 —— 有映射 且 在「已选类别」里。
            // ⚠ 两种模式都查已选（无 isAdv 前缀）：映射不随取消勾选删除，
            //    清空已选后若不过这道闸，仍会按旧映射提名 → "改了却还在动"
            var cands = [];
            for(var ck in d.class_conf){
              if(!Object.prototype.hasOwnProperty.call(d.class_conf, ck)) continue;
              if(!Object.prototype.hasOwnProperty.call(sortMap, ck)) continue;   // 未映射：静默忽略
              // 映射现在**不再随取消勾选而删除**（保留记忆），所以两种模式都必须查已选类别，
              // 否则清空已选后仍会按旧映射提名（"改了却还在动"）。
              // ⚠ 严格判定：已选为空时一律不放行（一个类别都没选 = 什么都不该分拣）
              if(selSet.indexOf(ck) < 0) continue;
              cands.push(ck);
            }
            var pick = null;
            if(cands.length){
              if((_ind.triggerMode || 'basic') === 'advanced'){
                pick = indPickAdvanced(cands, d);
              } else {
                pick = indPickBasic(cands, d);
              }
            }
            // 触发仲裁窗：首现合格者不立即放行，等 N 帧让后到的高优先级类别有机会反超
            // （例：钳子先通过防抖，枪晚一两帧才被识别到 → 窗口内枪反超，最终判定为枪）
            pick = indArbStep(pick);
            if(pick){
              if(pick.action === 'alarm'){
                // 仅报警：不驱动机械臂，画面红框闪烁 + 顶部横条 + 写一条记录
                indShowAlarm(pick.cls, pick.conf);
              } else {
                _ind.latestDetection = {defect_class: pick.cls, confidence: pick.conf};
              }
            }
            _ind._pendingClass = null;
          }
          indUpdateResText(targetW, targetH);   // 源分辨率 + 上传推理分辨率
          // 确保 cam-meta 可见
          var meta = document.querySelector('#ind-cam-box .cam-meta');
          if(meta) meta.style.display = '';
          // 实时 FPS：改用**指数滑动平均**——每帧都参与计算，显示每 200ms 刷新一次。
          // 原来是"累计满 1 秒才更新一次"，数字一秒才动一下、显得迟钝；
          // 这里既保留真实端到端帧率（含抓帧/上传/推理/渲染），又跟手。
          var now = performance.now();
          if(_ind.fpsPrevTs){
            var dt = now - _ind.fpsPrevTs;
            if(dt > 0){
              var inst = 1000 / dt;                       // 本帧瞬时帧率
              _ind.fpsEma = _ind.fpsEma ? (_ind.fpsEma * 0.75 + inst * 0.25) : inst;
            }
          }
          _ind.fpsPrevTs = now;
          if(now - (_ind.fpsShownTs || 0) >= 200){
            _ind.fpsShownTs = now;
            _ind.fpsText = 'FPS: ' + (_ind.fpsEma || 0).toFixed(1);   // 缓存：卡片重建时靠它回写
            var fpsEl = document.getElementById('ind-fps-inline') || document.getElementById('ind-fps');
            if(fpsEl) fpsEl.textContent = _ind.fpsText;
          }
        }
      })
      .catch(function(){
        // 网络错误，等 200ms 重试
      })
      .finally(function(){
        _ind.webcamBusy = false;
        // 链式触发下一帧
        if(_ind.cameraOn && _ind.inferOn){
          setTimeout(indCaptureFrame, 0);
        }
      });
  // 0.95：q0.7 的 JPEG 伪影会把贴阈值（conf≈0.5）的边缘目标置信度拉低 2~3 个点，
  // 造成帧间闪现/消失（实测 Pliers 0.89 时有时无）；提 quality 换取结果稳定，
  // 代价每帧体积 +30~50%（640 宽下约 50→70KB，每秒 1~2 帧可忽略）。不要低于 0.9
  }, 'image/jpeg', 0.95);
}

// ===== 检测框 canvas 绘制 =====
// 之前的做法：把后端画好框的整张 JPEG 覆盖到画面上 → 画面刷新率被推理帧率拖住（观感卡顿）。
// 现在：底层画面照常流畅播放，这里只用 canvas 画矩形+标签。
//
// 框比画面"慢一拍"是必然的：框来自几十毫秒前抓的那一帧。为了让框贴着物体走，
// 这里做两件事：
//   ① 插值：上一批框 → 本批框，按实测延迟（抓帧到结果返回）用 rAF 平滑过渡，
//      框就不会一跳一跳，而是连续移动（视觉上贴合很多）；
//   ② 外推：过渡走完后还没收到下一批结果时，按刚才的速度再往前推一点（带阻尼+上限），
//      把"慢一拍"补回来一点点，不会让框越推越远。
function indClearBoxes(){
  boxAnimStop('ind', null);   // 停掉动画（状态已迁到 _BOX_ANIMS['ind']）
  var cv = document.getElementById('ind-box-canvas');
  if(!cv) return;
  var g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  cv.style.display = 'none';
}

// 与 ultralytics 原生输出**同一套调色板**（20 色循环，按类别 id 取色）。
// 这样 canvas 画的框和图片/视频模式结果图里的框颜色完全一致，不同类别一眼可分。
var _BOX_COLORS = ['#FF3838','#FF9D97','#FF701F','#FFB21D','#CFD231','#48F90A','#92CC17',
                   '#3DDB86','#1A9334','#00D4BB','#2C99A8','#00C2FF','#344593','#6473FF',
                   '#0018EC','#8438FF','#520085','#CB38FF','#FF95C8','#FF37C7'];
function _boxColor(b){
  return _catColor(b && b.cls_name, b && b.cls);
}
function _boxFill(hex, a){
  var h = hex.replace('#', '');
  var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), bl = parseInt(h.substr(4, 2), 16);
  return 'rgba(' + r + ',' + g + ',' + bl + ',' + a + ')';
}

function _boxCopy(b){
  return {cls: b.cls, cls_name: b.cls_name, conf: b.conf,
          x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, alpha: 1};
}

// 上一批 -> 本批：按 cls_name + 中心距离最近匹配，逐框线性插值
function _boxLerp(prev, cur, t, frameW){
  frameW = frameW || indFrameW();
  if(!prev || !prev.length) return (cur || []).map(_boxCopy);
  if(!cur || !cur.length){
    // 目标消失：原地淡出，避免"闪一下就没"
    return prev.map(function(b){ var c = _boxCopy(b); c.alpha = Math.max(0, 1 - t); return c; });
  }
  var maxD = Math.pow(frameW * 0.3, 2);   // 匹配半径：帧宽的 30%，超出视为新目标
  var used = {}, out = [];
  cur.forEach(function(cb){
    var best = -1, bd = Infinity;
    prev.forEach(function(pb, i){
      if(used[i] || pb.cls_name !== cb.cls_name) return;
      var dx = (pb.x1 + pb.x2) / 2 - (cb.x1 + cb.x2) / 2;
      var dy = (pb.y1 + pb.y2) / 2 - (cb.y1 + cb.y2) / 2;
      var d = dx * dx + dy * dy;
      if(d < bd){ bd = d; best = i; }
    });
    if(best >= 0 && bd <= maxD){
      used[best] = 1;
      var pb = prev[best], c = _boxCopy(cb);
      c.x1 = pb.x1 + (cb.x1 - pb.x1) * t; c.y1 = pb.y1 + (cb.y1 - pb.y1) * t;
      c.x2 = pb.x2 + (cb.x2 - pb.x2) * t; c.y2 = pb.y2 + (cb.y2 - pb.y2) * t;
      out.push(c);
    } else {
      var n = _boxCopy(cb); n.alpha = Math.min(1, t * 2);   // 新目标：快速淡入
      out.push(n);
    }
  });
  return out;
}

// 画面分辨率显示：区分「源画面分辨率」与「上传推理分辨率」（上传固定缩到 640 宽）
function indUpdateResText(uw, uh){
  var el = document.getElementById('ind-cam-res');
  if(!el) return;
  var txt = (_ind.srcW && _ind.srcH) ? ('源 ' + _ind.srcW + '×' + _ind.srcH) : '--';
  if(uw && uh) txt += ' · 上传 ' + uw + '×' + uh;
  el.textContent = txt;
}

// ===== 检测框平滑动画（通用：工控页 与 智能检测页摄像头共用同一套） =====
// 每个画面用各自的 key 存一份动画状态，绘制函数由调用方注入。
var _BOX_ANIMS = {};

// 收到新结果：启动/续接一次平滑动画
function boxAnimUpdate(key, boxes, latency, frameW, activeFn, drawFn){
  var c = _BOX_ANIMS[key] || (_BOX_ANIMS[key] = {});
  c.frameW = frameW || 640;
  c.prev = (c.cur && c.cur.length) ? c.cur : ((boxes || []).map(_boxCopy));
  c.cur = (boxes || []).map(_boxCopy);
  c.start = performance.now();
  // 动画时长 = 实测延迟（抓帧→结果返回），即"框落后画面多少"，让过渡正好覆盖这段时间
  c.dur = Math.max(50, Math.min(300, latency || 120));
  if(c.raf) cancelAnimationFrame(c.raf);
  c.raf = requestAnimationFrame(function(){ boxAnimStep(key, activeFn, drawFn); });
}

function boxAnimStep(key, activeFn, drawFn){
  var c = _BOX_ANIMS[key];
  if(!c) return;
  c.raf = null;
  if(!activeFn()){ drawFn(null); return; }   // 画面已停止：收工
  var prev = c.prev || [], cur = c.cur || [];
  // 没有框：直接隐藏画布收工，别再 rAF 空转（每秒 60 次无谓重绘会拖低推理帧率）
  if(!prev.length && !cur.length){ drawFn(null); return; }
  var t = c.start ? (performance.now() - c.start) / (c.dur || 120) : 1;
  if(t <= 1){
    drawFn(_boxLerp(prev, cur, t, c.frameW));
    c.raf = requestAnimationFrame(function(){ boxAnimStep(key, activeFn, drawFn); });
    return;
  }
  // 过渡走完还没等到下一批结果：按刚才的速度做**阻尼外推**，把延迟补回来一点
  var ex = Math.min(0.6, (t - 1) * 0.5);          // 阻尼系数，最多再推 0.6 个"步长"
  var fw = c.frameW || 640, maxD = Math.pow(fw * 0.3, 2);
  var out = cur.map(function(cb){
    var b = _boxCopy(cb);
    for(var i = 0; i < prev.length; i++){
      if(prev[i].cls_name !== cb.cls_name) continue;
      var dx = (prev[i].x1 + prev[i].x2) / 2 - (cb.x1 + cb.x2) / 2;
      var dy = (prev[i].y1 + prev[i].y2) / 2 - (cb.y1 + cb.y2) / 2;
      if(dx * dx + dy * dy <= maxD){
        var vx = (cb.x1 - prev[i].x1), vy = (cb.y1 - prev[i].y1);
        b.x1 = cb.x1 + vx * ex; b.y1 = cb.y1 + vy * ex;
        b.x2 = cb.x2 + vx * ex; b.y2 = cb.y2 + vy * ex;
        break;
      }
    }
    return b;
  });
  drawFn(out);
  if(t < 3){   // 最多外推到 3 倍时长，避免越推越远
    c.raf = requestAnimationFrame(function(){ boxAnimStep(key, activeFn, drawFn); });
  }
}

function boxAnimStop(key, hideFn){
  var c = _BOX_ANIMS[key];
  if(!c) return;
  if(c.raf) cancelAnimationFrame(c.raf);
  c.raf = null; c.prev = null; c.cur = null; c.start = 0;
  if(hideFn) hideFn();
}

// 工控页入口：把动画接到 #ind-box-canvas
function indShowBoxesSmooth(boxes, roi){
  boxAnimUpdate('ind', boxes, _ind.lastLatency, indFrameW(),
    function(){ return _ind.cameraOn && _ind.inferOn; },
    function(list){
      if(list === null){ indClearBoxes(); return; }
      indDrawBoxes(list, roi);
    });
}

function indDrawBoxes(boxes, roi){
  var cv = document.getElementById('ind-box-canvas');
  var boxEl = document.getElementById('ind-cam-box');
  if(!cv || !boxEl) return;
  var bw = boxEl.clientWidth, bh = boxEl.clientHeight;
  var fw = indFrameW(), fh = indFrameH();
  if(!bw || !bh || !fw || !fh) return;
  // 对齐 object-fit: contain 的实际显示区域（画面框与帧比例不同会留黑边）
  var sc = Math.min(bw / fw, bh / fh);
  var ox = (bw - fw * sc) / 2, oy = (bh - fh * sc) / 2;
  var dpr = window.devicePixelRatio || 1;
  var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
  if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, bw, bh);
  cv.style.display = 'block';
  if(!boxes || !boxes.length) return;
  var dx = roi ? roi.x : 0, dy = roi ? roi.y : 0;   // ROI 模式：后端坐标是裁剪图坐标
  g.lineWidth = 2;
  g.font = '600 12px system-ui, "Microsoft YaHei", sans-serif';
  g.textBaseline = 'alphabetic';
  for(var i = 0; i < boxes.length; i++){
    var b = boxes[i];
    var x1 = (dx + b.x1) * sc + ox, y1 = (dy + b.y1) * sc + oy;
    var x2 = (dx + b.x2) * sc + ox, y2 = (dy + b.y2) * sc + oy;
    var al = (b.alpha === undefined) ? 1 : b.alpha;
    g.globalAlpha = al;
    var col = _boxColor(b);        // 按类别取色，与后端原生标注图同款配色
    g.fillStyle = _boxFill(col, .16);
    g.fillRect(x1, y1, x2 - x1, y2 - y1);
    g.strokeStyle = col;
    g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    var label = b.cls_name + ' ' + Math.round((b.conf || 0) * 100) + '%';
    g.font = '600 12px system-ui, "Microsoft YaHei", sans-serif';
    var tw = g.measureText(label).width;
    var ly = Math.max(0, y1 - 15);
    g.fillStyle = _boxFill(col, .92);
    g.fillRect(x1, ly, tw + 8, 15);
    g.fillStyle = '#ffffff';       // 标签用白字：类别色深浅不一，深色字在深蓝/紫上会看不清
    g.fillText(label, x1 + 4, ly + 11);
    g.globalAlpha = 1;
  }
}

// 统计卡片节流刷新：推理每帧都重建整个卡片的 innerHTML 会明显吃掉帧率，
// 而这块信息人眼 5 次/秒足够看 —— 只在间隔够 或 内容变化时真正重绘。
function indRenderDetectStatsThrottled(stats, total, ms){
  var key = JSON.stringify(stats) + '|' + total + '|' + ms;
  var now = performance.now();
  if(key === _ind.statsKey && (now - (_ind.statsTs || 0)) < 200) return;
  _ind.statsKey = key; _ind.statsTs = now;
  indRenderDetectStats(stats, total, ms);
}

function indRenderDetectStats(stats, total, ms){
  var box = document.getElementById('ind-detect-boxes');
  if(!box) return;
  var chips = [];
  for(var k in stats){
    chips.push('<span style="display:inline-block;padding:3px 10px;margin:0 4px 4px 0;border-radius:12px;background:rgba(201,152,107,.12);color:var(--accent);font-size:12px">'+k+'：'+stats[k]+'</span>');
  }
  // FPS 放在卡片里跟在单帧耗时后面（画面角落那个已隐藏，避免两处显示）。
  // ⚠ 卡片每帧重建 innerHTML，所以要回写缓存值，否则 FPS 会被冲成 "--"（每秒才更新一次）
  box.innerHTML = '<div style="margin-bottom:4px">总目标：<b style="color:var(--accent)">'+(total||0)+'</b>'
    + ' · 单帧 '+(ms||0)+'ms'
    + ' · <span id="ind-fps-inline">' + (_ind.fpsText || 'FPS: --') + '</span></div>'
    + (chips.join('') || '<span style="color:var(--text-3)">未检测到目标</span>');
}

// ===== 模型识别类别触发逻辑 =====
// 规则行 = 当前「已选类别」；启用状态不再单独勾选，跟类别选择走。
// **防抖帧数可调**（默认 2，弹窗「触发调优」）：普通/高级模式都有，从第①道检查就开始
// （高级模式中跟随类也须同帧稳定出现）。
// **计数失效时间**（默认 1000ms，可调，0=不失效）：超过该时长未再出现，防抖累计清零重计
// —— 否则画面空白几秒后同一类再闪一下，会续上旧的累计造成"瞬触发"（2026-10-21 用户报）。
// 两种规则模式（按模型记忆，弹窗顶部切换）：
//   basic 普通规则：防抖 → 选中类别中取置信度最高；并列 → 取目标数量最多；仍并列 → 随机
//   advanced 高级规则：四道检查
//     ① 资格门槛：仅「已选类别」且已配映射的参与；配了跟随类的须与其同帧同时出现；连续 N 帧稳定
//     ② 规则检查：满足 最小数量 / 置信度（类级优先，空=全局）/ 冷却 → 进入候选池
//     ③ 优先级判定：候选池按优先级分组取最小组；组内按置信度最高决胜（优先级允许重复）
//     ④ 兜底：组内置信度并列 → 取目标数量最多；仍并列 → 随机
// 高级规则结构：{类别: {priority, min_count, conf, cooldown, action, follow}}
//   priority: 1~99，可重复；min_count: 最少目标数；conf: 该类置信度门槛（空=全局）
//   cooldown: 触发后冷却秒数；action: sort=分拣 / alarm=仅报警
//   follow: 跟随类别数组（可含未选中的模型类别，本类须与其同帧同时出现才通过①）
// 触发调优（_ind.triggerTuning，按模型记忆）：仅 arb_frames 仲裁窗帧数可调（见下方"触发仲裁窗"一节）；
// 防抖帧数与计数失效时间均已写死，见 _IND_DEBOUNCE_FRAMES / _IND_EXPIRE_MS

// 防抖帧数：2026-10-21 深夜起**写死 3 帧，全局强制，不再开放用户调节**（原可调参数 debounce_frames
// 已从弹窗与 /api/arm/class-trigger-rules 接口移除，DB 里的遗留值一律忽略）。
// 与失效时间写死同一理由：把"设错就静默失效/行为漂移"的档位从用户手里收回来，参数面板只留仲裁一个旋钮。
// 3 帧在 5~10fps 下约 300~600ms，足以滤掉单帧误检，又不至于明显拖慢触发。
var _IND_DEBOUNCE_FRAMES = 3;
function _indDebounceFrames(){ return _IND_DEBOUNCE_FRAMES; }

// 计数失效时间：2026-10-21 起**写死 500ms，不再开放用户调节**（原可调参数 expire_ms
// 已从弹窗与 /api/arm/class-trigger-rules 接口移除，DB 里的遗留值一律忽略）。
// 写死的原因：失效判定是"逐帧间隔"——该值一旦小于实际帧间隔（8fps≈125ms），
// 防抖会每帧清零（永远攒不满）+ 仲裁窗每帧作废重开（永远攒不满 3），全链路静默失效且无任何报错。
// 500ms 在 5~10fps 下有 2.5~5 倍余量（安全线 ≥2~3× 帧间隔）。
// 旧语义"0=不失效"一并作废（按"越小间隔越短"的直觉，0 本应表示永远清零；
// 若将来重新开放，永不清效应用独立开关表达，不用 999999999 这类魔术大数）。
var _IND_EXPIRE_MS = 500;
function _indExpireMs(){ return _IND_EXPIRE_MS; }

// 普通规则挑选：防抖（帧数可调）→ 置信度最高 → 并列比数量 → 再并列随机
// 不走任何规则表格配置；防抖状态与高级模式共用 _ind.triggerState
function indPickBasic(cands, d){
  var _st = _ind.triggerState || (_ind.triggerState = {});
  var now = Date.now() / 1000;
  var nowMs = Date.now();
  var need = _indDebounceFrames();
  var expireMs = _indExpireMs();
  // ① 防抖：每个候选类别需连续 N 帧稳定出现，才进入本帧有效候选集
  var valid = [];
  cands.forEach(function(ck){
    var s = _st[ck] || {frames: 0, last: 0, seen: 0};
    // 超时未再现：之前的累计作废，从头开始计（画面空白期不会续旧账）
    if(expireMs > 0 && s.seen && (nowMs - s.seen) > expireMs){ s.frames = 0; }
    s.seen = nowMs;
    s.frames = (s.frames || 0) + 1;
    _st[ck] = s;
    if(s.frames >= need) valid.push(ck);
  });
  // 本帧未出现的候选类：帧计数清零（防抖重新累计），保留上次触发时刻与最近出现时刻
  for(var k in _st){
    if(!Object.prototype.hasOwnProperty.call(_st, k)) continue;
    if(cands.indexOf(k) < 0) _st[k] = {frames: 0, last: _st[k].last || 0, seen: _st[k].seen || 0};
  }
  if(!valid.length) return null;
  // ② 有效候选内取置信度最高；③ 并列比目标数量；④ 仍并列随机
  var best = null;
  valid.forEach(function(ck){
    var conf = d.class_conf[ck];
    var cnt = (d.stats && d.stats[ck]) || 0;
    if(!best || conf > best.conf || (conf === best.conf && cnt > best.cnt)){
      best = {cls: ck, conf: conf, cnt: cnt};
    }
  });
  // 与最优项「置信度 + 数量」完全并列的（极小概率）：随机取一个
  var ties = valid.filter(function(ck){
    return d.class_conf[ck] === best.conf && ((d.stats && d.stats[ck]) || 0) === best.cnt;
  });
  var chosen = best;
  if(ties.length > 1){
    var c = ties[Math.floor(Math.random() * ties.length)];
    chosen = {cls: c, conf: d.class_conf[c], cnt: (d.stats && d.stats[c]) || 0, action: 'sort'};
  } else {
    chosen = {cls: best.cls, conf: best.conf, cnt: best.cnt, action: 'sort'};
  }
  // 触发后回写：仅清零防抖帧计数（下次需重新连续 N 帧才能再被选中）。
  // ⚠ 冷却时间戳 last 绝不在挑选阶段写——否则仲裁窗内每帧都会把 last 刷成"当前时刻"，
  //   高优先级类别（如枪）在自家冷却窗内被挡、低优先级（如钳）顶上，表现成"设了冷却就无视优先级"。
  //   冷却只在「提名被后端接受」时由 indSorterPoll 起算（见该函数 triggered 分支）。
  var s2 = _st[chosen.cls];
  if(s2){ s2.frames = 0; }
  return chosen;
}

// 高级规则挑选：四道检查，返回 {cls, conf, cnt, action} 或 null
// ① 资格门槛：已选+有映射（调用方已过）+ 跟随类同帧出现 + 连续 2 帧防抖（防抖从这里开始）
// ② 规则检查：最小数量 / 置信度（类级优先，空=全局）/ 冷却 → 进候选池
// ③ 优先级判定：候选池按优先级分组取最小组；组内按置信度最高决胜（优先级允许重复）
// ④ 兜底：组内置信度并列 → 取目标数量最多；仍并列 → 随机
// 规则结构新增 follow：跟随类别数组（可含未选中的模型类别）
function indPickAdvanced(cands, d){
  var gConf = readConfValue('ind-conf-value');
  var _st = _ind.triggerState || (_ind.triggerState = {});
  var now = Date.now() / 1000;
  var nowMs = Date.now();
  var need = _indDebounceFrames();
  var expireMs = _indExpireMs();
  var pool = [];
  cands.forEach(function(ck){
    var rule = (_ind.triggerRules || {})[ck] || {};
    var conf = d.class_conf[ck];
    var cnt = (d.stats && d.stats[ck]) || 0;
    // ① 资格门槛：本类出现 + 配置的跟随类同帧同时出现；该状态连续 N 帧稳定
    //    （防抖从第一道检查就开始，资格不过则清零重新累计）
    var follow = rule.follow || [];
    var followOk = follow.every(function(f){
      return Object.prototype.hasOwnProperty.call(d.class_conf, f);
    });
    var s = _st[ck] || {frames: 0, last: 0, seen: 0};
    // 超时未再现（画面空白期）：累计作废重新计。seen 在跟随不满时也刷新——
    // 类本身在场，只是跟随类没来，不算"消失"
    if(expireMs > 0 && s.seen && (nowMs - s.seen) > expireMs){ s.frames = 0; }
    s.seen = nowMs;
    if(!followOk){
      _st[ck] = {frames: 0, last: s.last || 0, seen: s.seen};
      return;
    }
    s.frames = (s.frames || 0) + 1;
    _st[ck] = s;
    if(s.frames < need) return;   // 防抖未满，不进入②
    // ② 规则检查：最小数量 + 置信度门槛（仅"显式配置"的逐类门槛才过滤）+ 冷却。
    //    失败仅本帧不进池，不清帧——资格防抖已在①完成，瞬时条件满足即生效
    // ⚠ 不再把全局探测置信度(gConf)当作默认门槛：探测阶段已按 ind-conf-value 筛过一遍，
    //    这里再套全局 0.5 会导致"只为设冷却切到高级规则"时，所有低置信度类别（如枪）
    //    被每一帧静默过滤——表现为"设了冷却反而再也不捡某类"。逐类没配 conf 就放行。
    var minCount = rule.min_count || 1;
    var gate = (rule.conf === null || rule.conf === undefined) ? null : rule.conf;
    if(cnt < minCount || (gate !== null && conf < gate)) return;
    var cd = rule.cooldown || 0;
    if(cd > 0 && s.last && (now - s.last) < cd) return;   // 冷却中，不进候选池
    pool.push({cls: ck, conf: conf, cnt: cnt,
               priority: rule.priority || 99, action: rule.action || 'sort'});
  });
  // 本帧未出现的候选类（掉出画面/被取消勾选）：帧计数清零，防止"闪一下就消失"
  // 被断断续续的帧累计成连续 N 帧
  for(var k in _st){
    if(!Object.prototype.hasOwnProperty.call(_st, k)) continue;
    if(cands.indexOf(k) < 0) _st[k] = {frames: 0, last: _st[k].last || 0, seen: _st[k].seen || 0};
  }
  if(!pool.length) return null;
  // ③ 优先级判定：取最小优先级组（优先级允许重复，同组竞技）
  var minP = pool[0].priority;
  pool.forEach(function(x){ if(x.priority < minP) minP = x.priority; });
  var grp = pool.filter(function(x){ return x.priority === minP; });
  var topConf = grp[0].conf;
  grp.forEach(function(x){ if(x.conf > topConf) topConf = x.conf; });
  var byConf = grp.filter(function(x){ return x.conf === topConf; });
  var chosen;
  if(byConf.length === 1){
    chosen = byConf[0];
  } else {
    // ④ 兜底：置信度并列 → 数量最多；仍并列 → 随机
    var maxCnt = byConf[0].cnt;
    byConf.forEach(function(x){ if(x.cnt > maxCnt) maxCnt = x.cnt; });
    var byCnt = byConf.filter(function(x){ return x.cnt === maxCnt; });
    chosen = byCnt[Math.floor(Math.random() * byCnt.length)];
  }
  // 触发后回写：仅清零防抖帧计数（与基础模式一致）。
  // ⚠ 冷却时间戳 last 不在挑选阶段写——理由同上：避免仲裁窗内每帧刷新 last 导致
  //   自家冷却把高优先级类挡在候选池外。冷却起算统一交给 indSorterPoll 的接受分支。
  var s2 = _st[chosen.cls];
  if(s2){ s2.frames = 0; }
  return chosen;
}

// ===== 触发仲裁窗（跨帧优先级决胜，2026-10-21 新增）=====
// 要解决的问题：挑选是「单帧决胜」——低优先级类别（如钳子）先通过防抖就会先触发，
// 高优先级类别（如枪）哪怕只晚一两帧才被识别到（光线/角度），也只能吃冷却，
// 本轮被低危类抢占，与"枪才是本轮真正该判定的目标"相悖。
//
// 机制：首个合格者出现后**不立即触发**，而是开一个 N 帧的窗口
// （_ind.triggerTuning.arb_frames，按模型配置，0=关闭 → 恢复单帧决胜）；
// 窗口内每个有检测结果的帧都计数，本帧合格者随时吸收（更优才替换），
// 窗口结束放行「全程最优」：
//   高级规则：优先级小者优 → 置信度高者优 → 目标数量多者优
//   普通规则：置信度高者优 → 目标数量多者优（无比优先级概念）
// 防挂死：窗口进行中若超过失效时间（写死 500ms，见 _IND_EXPIRE_MS）没有新的检测结果帧
// （画面空白/循环停顿），窗口**作废重开**而不是放行陈旧的 best（与防抖计数同一口径：没再现就重新来）。
// 失效时间恒为正，_ARB_MAX_MS 的 2s 硬上限目前不会触发，仅作将来引入"不失效"档位时的兜底。
// 停止推理/停止分拣/切模型/改配置都会关窗（见各 indArbReset 调用点）。
var _ARB_MAX_MS = 2000;

function indArbReset(){
  _ind.arb = null;
}

// 触发状态「全部失效」：防抖累计 + 仲裁窗一起清零。
// 用于**确定性事件**（不依赖失效时间，杜绝"旧账跨事件续上"）：
//   分拣/动作组执行完毕、停止分拣、重开分拣、急停、切换模型、换检测源、
//   停止推理、修改规则/模式/调优。
// ⚠ indArbStep 内部只用 indArbReset（只关窗不清计数）——那边要靠计数连续累积。
function indInvalidateTrigger(resetCooldown){
  // 只清防抖累计(frames)和仲裁窗；默认**保留**每类的冷却时间戳(last)。
  // 原实现把整个 triggerState 清空，导致每轮分拣一完成冷却计时也被抹掉——
  // 冷却因此永远跨不到下一轮（实测：设 1000s 冷却仍每轮都捡，完全无效）。
  // 冷却是"时间窗"语义，本就该跨轮累计；只有防抖需要定性清零重计。
  //
  // 但若 resetCooldown=true（保存触发规则 / 切换模型 / 进页面）：冷却计时一并归零。
  // 原因：这是用户**显式改了冷却配置**的确定性事件——旧的 last 是按旧冷却窗口写的，
  // 倒追到新窗口会让"改完第一次"永远被挡（实测：cd 从 1 改 1000 后每轮都捡钳）。
  // 归零后下一帧视为"首次"，才能兑现"改完第一次先捡枪、之后 1000s 内才捡钳"。
  if(_ind.triggerState){
    for(var k in _ind.triggerState){
      if(!Object.prototype.hasOwnProperty.call(_ind.triggerState, k)) continue;
      var st = _ind.triggerState[k];
      st.frames = 0;   // 防抖重新累计
      st.seen = 0;     // 失效计时也重来
      if(resetCooldown) st.last = 0;   // 配置重载/保存：冷却计时归零，新意图从"首次"开始
      // 否则 st.last 保留：冷却时间戳，跨轮有效（到点自然失效）
    }
  }
  _ind.arb = null;
  // 一并清掉待推送的检测：否则本轮结束瞬间若残留一个（抓帧与主循环在
  // sorterBusy 置 true 前那一小段窗口里提名的）detection，会在下一轮
  // sorterBusy 变 false 时直接被推进后端，绕过刚清零的防抖+仲裁
  _ind.latestDetection = null;
}

// 排序键（升序=更优）
function _arbRank(x, isAdv){
  return isAdv ? [(x.priority || 99), -(x.conf || 0), -(x.cnt || 0)]
               : [-(x.conf || 0), -(x.cnt || 0)];
}

// a 是否严格优于 b（完全同分不算优于：先到者保持，避免抖动换手）
function _arbBetter(a, b, isAdv){
  if(!b) return true;
  var ka = _arbRank(a, isAdv), kb = _arbRank(b, isAdv);
  for(var i = 0; i < ka.length; i++){
    if(ka[i] < kb[i]) return true;
    if(ka[i] > kb[i]) return false;
  }
  return false;
}

// 在 indCaptureFrame 里调用：吸收本帧合格者，返回真正该放行的 pick（null=继续等）
function indArbStep(pick){
  var t = _ind.triggerTuning || {};
  var need = (typeof t.arb_frames === 'number') ? t.arb_frames : 3;
  if(need <= 0){ indArbReset(); return pick; }   // 关闭仲裁：维持单帧决胜
  var isAdv = ((_ind.triggerMode || 'basic') === 'advanced');
  var nowTs = Date.now();
  var expireMs = _indExpireMs();
  var arb = _ind.arb;
  if(arb && arb.active){
    // 中途"没出现"超过失效时间（500ms）：窗口作废重开，不放行陈旧的 best
    // （失效时间恒为正；_ARB_MAX_MS 兜底目前不会走到）
    var idleLimit = expireMs > 0 ? expireMs : _ARB_MAX_MS;
    if((nowTs - (arb.lastAt || arb.startedAt)) > idleLimit){
      indArbReset();
      if(pick){
        _ind.arb = {active: true, best: pick, frames: 1, need: need,
                    startedAt: nowTs, lastAt: nowTs};
      }
      return null;
    }
    arb.lastAt = nowTs;
    // 窗口进行中：计数推进；合格者随时吸收（仅更优替换）；到点放行最优
    arb.frames++;
    if(pick && _arbBetter(pick, arb.best, isAdv)) arb.best = pick;
    if(arb.frames >= arb.need){
      var best = arb.best;
      indArbReset();
      return best;
    }
    return null;
  }
  if(pick){
    // 首个合格者：开窗。need 锁进本窗——中途改配置不影响进行中的窗口
    _ind.arb = {active: true, best: pick, frames: 1, need: need,
                startedAt: nowTs, lastAt: nowTs};
  }
  return null;
}

function indDefaultTriggerRule(idx){
  return {priority: idx + 1, min_count: 1, conf: null, cooldown: 0, action: 'sort', follow: []};
}

function indRenderTriggerSummary(){
  var el = document.getElementById('ind-trigger-summary');
  if(!el) return;
  var sel = _ind.selectedClasses || [];
  if(!sel.length){
    el.innerHTML = '<span style="color:var(--text-3)">尚未选择类别，请先在上方「类别选择」中勾选需要触发分拣的类别</span>';
    return;
  }
  var isAdv = (_ind.triggerMode === 'advanced');
  // 模式行只留一句话；完整机制说明在「配置触发逻辑」弹窗内
  var modeLine = '<div style="margin-bottom:6px">当前模式：<b style="color:var(--accent)">' +
    (isAdv ? '高级规则' : '普通规则') + '</b>' +
    '<span style="color:var(--text-3)"> · ' +
    (isAdv ? '四道检查 · 同级按置信度决胜' : '连续 3 帧防抖后取置信度最高') +
    '</span></div>';
  // 调优状态行：防抖/失效为写死值，仅仲裁可调（仲裁关闭时不显示该项）
  var t = _ind.triggerTuning || {};
  var tuneParts = [
    '防抖 <b style="color:var(--accent)">3</b> 帧',
    '失效 <b style="color:var(--accent)">500ms</b>'
  ];
  if((t.arb_frames || 0) > 0){
    tuneParts.push('仲裁 <b style="color:var(--accent)">' + t.arb_frames + '</b> 帧（可调，有效反超 ' + (t.arb_frames - 3) + ' 帧）');
  }
  var tuneLine = '<div style="margin-bottom:6px;color:var(--text-3)">' + tuneParts.join(' · ') + '</div>';
  if(!isAdv){
    el.innerHTML = modeLine + tuneLine +
      '<div style="color:var(--text-3)">无需逐类配置，对全部已选类别生效；切到高级规则可精细控制。</div>';
    return;
  }
  // 规则行：默认值（最小1个/全局置信度/不冷却/分拣）一律省略，只列出非默认配置；
  // 用标签横向排布（flex-wrap），避免每个类别单独占一行浪费右侧空间
  var chips = sel.map(function(c){
    var r = (_ind.triggerRules || {})[c] || {};
    var extra = [];
    if((r.min_count || 1) > 1) extra.push('≥' + r.min_count + '个');
    if(r.conf !== null && r.conf !== undefined) extra.push('置信≥' + parseFloat(r.conf).toFixed(2));
    if(r.cooldown) extra.push('冷却' + r.cooldown + 's');
    if((r.action || 'sort') === 'alarm') extra.push('<b style="color:var(--accent)">仅报警</b>');
    var fl = r.follow || [];
    if(fl.length){
      extra.push('跟 <b style="color:var(--text-2)">' +
        (fl.length <= 2 ? fl.join('、') : fl.length + '类') + '</b>');
    }
    var plain = extra.join(' · ').replace(/<[^>]*>/g, '');
    return '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;' +
      'background:var(--card-2);border:1px solid var(--border);border-radius:6px;' +
      'font-size:11.5px;color:var(--text-2);white-space:nowrap" ' +
      'title="优先级 ' + (r.priority || '-') + (plain ? ' · ' + plain : '') + '">' +
      '<b style="color:var(--accent)">' + (r.priority || '-') + '</b>' + c +
      (extra.length ? ' <span style="color:var(--text-3)">' + extra.join(' ') + '</span>' : '') +
      '</span>';
  }).join('');
  el.innerHTML = modeLine + tuneLine +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + chips + '</div>';
}

// 模式切换（弹窗内临时态，保存时写入）
// 规则模式切换：只切弹窗内的预览态（按钮高亮/流程卡/表格显隐），
// 与表格编辑、仲裁值统一——点「保存」才落库生效（2026-10-22 改；
// 旧实现是即时 POST，与"其他填写框要保存"的逻辑不统一）
function indSetTriggerMode(mode){
  if(mode !== 'basic' && mode !== 'advanced') return;
  var d = _ind._trDraft || (_ind._trDraft = {mode: _ind.triggerMode});
  if(d.mode === mode) return;
  d.mode = mode;
  trRenderModeDesc();
}

// 渲染弹窗内的模式说明（流程步骤）+ 模式按钮态 + 表格显隐
function trRenderModeDesc(){
  var desc = document.getElementById('tr-mode-desc');
  var basicBtn = document.getElementById('tr-mode-basic');
  var advBtn = document.getElementById('tr-mode-advanced');
  var tableWrap = document.getElementById('tr-table-wrap');
  // 弹窗内看草稿模式（未保存的切换），无草稿时看已生效模式
  var isAdv = ((_ind._trDraft && _ind._trDraft.mode) || _ind.triggerMode) === 'advanced';
  if(basicBtn){
    basicBtn.className = 'btn btn-sm ' + (isAdv ? 'btn-ghost' : 'btn-primary');
    basicBtn.style.flex = '1';
  }
  if(advBtn){
    advBtn.className = 'btn btn-sm ' + (isAdv ? 'btn-primary' : 'btn-ghost');
    advBtn.style.flex = '1';
  }
  if(tableWrap) tableWrap.style.display = isAdv ? '' : 'none';
  if(!desc) return;
  var _df = _indDebounceFrames();
  var steps = isAdv ? [
    ['① 资格门槛', '已选类别且已配映射；配了跟随类的须与其同帧同时出现；该状态连续 ' + _df + ' 帧稳定（防抖从此开始）'],
    ['② 规则检查', '满足最小数量 / 置信度 / 冷却 → 进入候选池'],
    ['③ 优先级判定', '候选池按优先级分组取最小组；组内按置信度最高决胜（优先级可重复）'],
    ['④ 兜底检查', '组内置信度并列 → 取目标数量最多；仍并列 → 随机挑一个']
  ] : [
    ['① ' + _df + ' 帧防抖', '已选类别需连续 ' + _df + ' 帧稳定出现才生效（防单帧抖动误触发）'],
    ['② 取置信度最高', '通过防抖的类别中挑置信度最高的一个作为分拣对象'],
    ['③ 并列比数量', '多个类别最高置信度相同 → 取目标数量最多的一类'],
    ['④ 仍并列随机', '数量仍相同 → 随机挑一个']
  ];
  var flow = '<div style="display:flex;align-items:stretch;gap:6px;margin:10px 0 4px;flex-wrap:wrap">' +
    steps.map(function(s, i){
      return '<div style="flex:1;min-width:150px;background:var(--card-2);border:1px solid var(--border);' +
        'border-radius:8px;padding:8px 10px">' +
        '<div style="font-size:12.5px;font-weight:500;color:var(--text-1);margin-bottom:3px">' + s[0] + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-3);line-height:1.6">' + s[1] + '</div></div>';
    }).join('') + '</div>';
  var intro = isAdv
    ? '<div style="font-size:12.5px;color:var(--text-2);line-height:1.75">画面内每个类别依次通过四道检查，' +
      '最终只有一个类别被执行：</div>'
    : '<div style="font-size:12.5px;color:var(--text-2);line-height:1.75">最原始的分拣规则，无需任何参数配置，' +
      '直接对全部已选类别生效：</div>';
  var foot = isAdv
    ? '<div style="font-size:11.5px;color:var(--text-3);line-height:1.7;margin-top:8px">' +
      '表格仅在高级规则下生效；<b>优先级允许重复</b>（如多个类别同为第一优先级，组内按置信度最高者胜出）。</div>'
    : '<div style="font-size:11.5px;color:var(--text-3);line-height:1.7;margin-top:8px">' +
      '普通模式下不读取下方规则表格；需要逐类控制时请切换到「高级规则」。</div>';
  desc.innerHTML = intro + flow + foot;
}

// 打开规则弹窗：按当前已选类别渲染表格 + 初始化模式草稿 + 回填调优参数
function openTriggerRules(){
  var sel = _ind.selectedClasses || [];
  if(!sel.length){ toast('请先在上方「类别选择」中勾选类别'); return; }
  // 弹窗草稿：模式切换只改草稿，与表格/仲裁统一——保存才生效
  _ind._trDraft = { mode: (_ind.triggerMode === 'advanced') ? 'advanced' : 'basic' };
  indRefreshTriggerRules();
  trRenderModeDesc();
  var t = _ind.triggerTuning || {};
  var setV = function(id, v){ var el = document.getElementById(id); if(el) el.value = v; };
  setV('tr-arb-frames', (typeof t.arb_frames === 'number') ? t.arb_frames : 6);
  openModal('trigger-rules-modal');
}

// useDefaults=true 时忽略已生效规则、按 indDefaultTriggerRule 渲染（恢复默认用，
// 只改弹窗显示不动 _ind.triggerRules——保存才落库）
function indRefreshTriggerRules(useDefaults){
  var body = document.getElementById('trigger-rules-body');
  if(!body) return;
  var sel = (_ind.selectedClasses || []).slice();
  if(!useDefaults){
    // 按优先级排序展示，未配置的排在后面
    sel.sort(function(a,b){
      var pa = ((_ind.triggerRules||{})[a]||{}).priority || 99;
      var pb = ((_ind.triggerRules||{})[b]||{}).priority || 99;
      return pa - pb;
    });
  }
  body.innerHTML = sel.map(function(c, i){
    var r = useDefaults ? indDefaultTriggerRule(i) : ((_ind.triggerRules || {})[c] || {});
    var pr = r.priority || (i + 1);
    var mc = r.min_count || 1;
    var cf = (r.conf === null || r.conf === undefined) ? '' : r.conf;
    var cd = r.cooldown || '';
    var act = r.action || 'sort';
    // 跟随类别：本类须与其同时出现才通过①资格门槛；可含未选中的模型类别
    var fl = r.follow || [];
    var flLabel = fl.length ? (fl.length <= 2 ? fl.join('、') : fl.length + ' 个类') : '+ 跟随';
    var flStyle = fl.length
      ? 'color:var(--accent);border-color:rgba(201,152,107,.4);background:rgba(201,152,107,.12)'
      : 'color:var(--text-3)';
    return '<tr style="border-top:1px solid var(--border)">'+
      '<td style="padding:6px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+c+'">'+c+'</td>'+
      '<td style="padding:6px 8px"><input type="number" class="input tr-priority" data-cls="'+c+'" value="'+pr+'" min="1" max="99" style="width:52px;font-size:12px;padding:3px 4px"></td>'+
      '<td style="padding:6px 8px"><input type="number" class="input tr-mincount" data-cls="'+c+'" value="'+mc+'" min="1" style="width:52px;font-size:12px;padding:3px 4px"></td>'+
      '<td style="padding:6px 8px"><input type="number" class="input tr-conf" data-cls="'+c+'" value="'+cf+'" min="0.05" max="0.95" step="0.05" placeholder="全局" style="width:60px;font-size:12px;padding:3px 4px"></td>'+
      '<td style="padding:6px 8px"><input type="number" class="input tr-cooldown" data-cls="'+c+'" value="'+cd+'" min="0" step="1" placeholder="0" style="width:52px;font-size:12px;padding:3px 4px"></td>'+
      '<td style="padding:6px 8px"><select class="input tr-action" data-cls="'+c+'" style="width:70px;font-size:12px;padding:3px 4px">'+
        '<option value="sort"'+(act==='sort'?' selected':'')+'>分拣</option>'+
        '<option value="alarm"'+(act==='alarm'?' selected':'')+'>仅报警</option>'+
      '</select></td>'+
      '<td style="padding:6px 8px"><button type="button" class="btn btn-sm tr-follow-btn" data-cls="'+c+'" '+
        'data-follow=\''+JSON.stringify(fl)+'\' onclick="openFollowPicker(\''+c+'\')" '+
        'style="width:78px;font-size:11px;padding:3px 4px;'+flStyle+'">'+flLabel+'</button></td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="7" style="padding:12px;color:var(--text-3);text-align:center">尚未选择类别</td></tr>';
}

// 规则行跟随类别选择：只保留已选类别的行，新类别自动补默认值
function indSyncTriggerRules(){
  var sel = _ind.selectedClasses || [];
  var rules = _ind.triggerRules || (_ind.triggerRules = {});
  sel.forEach(function(c, i){
    if(!rules[c]) rules[c] = indDefaultTriggerRule(i);
  });
  // 已取消勾选的类别：规则保留（再勾回来还在），但不参与触发
}

// 读取某一行的跟随类别配置（data-follow JSON），异常时退回空数组
function trFollowOf(tr){
  var btn = tr.querySelector('.tr-follow-btn');
  if(!btn) return [];
  try{
    var v = JSON.parse(btn.dataset.follow || '[]');
    return Array.isArray(v) ? v : [];
  }catch(e){ return []; }
}

// 跟随类别选择浮层：可多选「模型支持的全部类别」（含未选中的），排除自身
function openFollowPicker(cls){
  var all = _ind.modelClasses || [];
  if(!all.length){ toast('请先开启摄像头加载模型'); return; }
  var rowBtn = document.querySelector('.tr-follow-btn[data-cls="'+cls+'"]');
  var draft = [];
  if(rowBtn){
    try{
      var v = JSON.parse(rowBtn.dataset.follow || '[]');
      draft = Array.isArray(v) ? v : [];
    }catch(e){ draft = []; }
  }
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:12px;' +
    'padding:18px;width:340px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column';
  var titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
  var t = document.createElement('span');
  t.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-1)';
  t.textContent = '配置「' + cls + '」的跟随类别';
  var sub = document.createElement('div');
  sub.style.cssText = 'font-size:11.5px;color:var(--text-3);line-height:1.7;margin-bottom:12px';
  sub.innerHTML = '勾选的类别必须与 <b style="color:var(--text-2)">' + cls + '</b> ' +
    '<b style="color:var(--text-2)">同一帧同时出现</b>，本类才参与触发判定。' +
    '可多选，范围含未在上方「类别选择」中勾选的类别；留空表示不跟随。';
  var listWrap = document.createElement('div');
  listWrap.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px';
  all.forEach(function(c2){
    if(c2 === cls) return;   // 不允许跟随自己
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:12.5px;color:var(--text-2)';
    row.onmouseenter = function(){ row.style.background = 'var(--card-2)'; };
    row.onmouseleave = function(){ row.style.background = ''; };
    var cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.checked = draft.indexOf(c2) >= 0;
    cbx.style.cssText = 'accent-color:var(--accent)';
    var nm = document.createElement('span');
    nm.textContent = c2;
    row.appendChild(cbx); row.appendChild(nm);
    listWrap.appendChild(row);
  });
  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.style.cssText = 'flex:1;padding:9px';
  cancelBtn.textContent = '取消';
  var okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.style.cssText = 'flex:1;padding:9px;font-weight:700';
  okBtn.textContent = '确定';
  function closeDlg(){ if(overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  cancelBtn.onclick = closeDlg;
  okBtn.onclick = function(){
    var picked = [];
    listWrap.querySelectorAll('input[type=checkbox]').forEach(function(cbx, i){
      if(cbx.checked){
        // 与渲染顺序一致：跳过自身后按 modelClasses 顺序取
        var names = all.filter(function(x){ return x !== cls; });
        picked.push(names[i]);
      }
    });
    // 只更新按钮显示 + dataset（UI 即数据源，保存时从 dataset 收集）——
    // 不再直接写 _ind.triggerRules：跟随类别与其他表格字段统一，保存才生效
    if(rowBtn){
      rowBtn.dataset.follow = JSON.stringify(picked);
      rowBtn.textContent = picked.length
        ? (picked.length <= 2 ? picked.join('、') : picked.length + ' 个类')
        : '+ 跟随';
      rowBtn.style.color = picked.length ? 'var(--accent)' : 'var(--text-3)';
      rowBtn.style.borderColor = picked.length ? 'rgba(201,152,107,.4)' : '';
      rowBtn.style.background = picked.length ? 'rgba(201,152,107,.12)' : '';
    }
    closeDlg();
  };
  btnRow.appendChild(cancelBtn); btnRow.appendChild(okBtn);
  titleRow.appendChild(t);
  box.appendChild(titleRow); box.appendChild(sub); box.appendChild(listWrap); box.appendChild(btnRow);
  overlay.appendChild(box);
  overlay.onclick = function(e){ if(e.target === overlay) closeDlg(); };
  document.body.appendChild(overlay);
}

// 规则表格单行校验（纯函数，可单测）：合法返回 null，否则返回 {field, msg}
// field 与输入框的 class 后缀对应（priority/mincount/conf/cooldown），便于定位 focus
function trValidateRow(cls, v){
  var pv = parseInt(v.priority, 10);
  if(!isFinite(pv) || pv < 1 || pv > 99) return {field:'priority', msg:'「'+cls+'」的优先级需为 1～99 的整数'};
  var mv = parseInt(v.min_count, 10);
  if(!isFinite(mv) || mv < 1 || mv > 999) return {field:'mincount', msg:'「'+cls+'」的最小数量需为 1～999 的整数'};
  var cv = String(v.conf == null ? '' : v.conf).trim();
  if(cv !== ''){
    var fv = parseFloat(cv);
    if(!isFinite(fv) || fv < 0.05 || fv > 0.95) return {field:'conf', msg:'「'+cls+'」的置信度门槛需在 0.05～0.95 之间（留空=全局）'};
  }
  var dv = String(v.cooldown == null ? '' : v.cooldown).trim();
  if(dv !== ''){
    var dvv = parseFloat(dv);
    if(!isFinite(dvv) || dvv < 0 || dvv > 86400) return {field:'cooldown', msg:'「'+cls+'」的冷却需为 0～86400 之间的数字（秒）'};
  }
  return null;
}

// 收集表格 -> 保存（含规则模式；优先级允许重复，不再做唯一性校验）
function indSaveTriggerRules(){
  // ① 收集各行 + 逐行校验：原来只在校集时静默强转（打 9、字母、负数要么无声通过、
  //    要么整行被丢且不提示是哪个类别），现在不过就 toast + 聚焦，不发请求
  var rows = [];
  document.querySelectorAll('#trigger-rules-body tr').forEach(function(tr){
    var any = tr.querySelector('[data-cls]');
    if(!any) return;   // "尚未选择类别"占位行
    var g = function(sel){ var el = tr.querySelector(sel); return el ? el.value : ''; };
    rows.push({
      cls: any.dataset.cls, el: tr,
      priority: g('.tr-priority'), min_count: g('.tr-mincount'),
      conf: g('.tr-conf'), cooldown: g('.tr-cooldown'),
      action: g('.tr-action') || 'sort', follow: trFollowOf(tr)
    });
  });
  for(var i = 0; i < rows.length; i++){
    var bad = trValidateRow(rows[i].cls, rows[i]);
    if(bad){
      toast(bad.msg);
      var el = rows[i].el.querySelector('.tr-' + bad.field);
      if(el) el.focus();
      return;
    }
  }
  // ② 收集规则（校验已过，值均在合法范围）
  var rules = {};
  rows.forEach(function(r){
    var cfRaw = r.conf, cdRaw = r.cooldown;
    var conf = (cfRaw === '' || cfRaw === null || cfRaw === undefined) ? null : parseFloat(cfRaw);
    rules[r.cls] = {
      priority: parseInt(r.priority, 10) || 99,
      min_count: parseInt(r.min_count, 10) || 1,
      conf: conf,
      cooldown: (cdRaw === '' || cdRaw === null) ? 0 : (parseFloat(cdRaw) || 0),
      action: r.action,
      follow: r.follow
    };
  });
  // 模式取弹窗草稿（预览态），与表格/仲裁一起保存才生效
  var mode = ((_ind._trDraft && _ind._trDraft.mode) || _ind.triggerMode || 'basic');
  // 触发调优仅剩仲裁帧数一项（与规则一起按模型保存）；
  // 防抖（3 帧）与失效时间（500ms）均已写死，不随用户配置收发
  var numV = function(id, def){
    var el = document.getElementById(id);
    var v = el ? parseInt(el.value, 10) : def;
    return isNaN(v) ? def : v;
  };
  var arbFrames = numV('tr-arb-frames', 6);
  // 有效取值只有 0（关闭）和 4~10：防抖写死 3 帧，"有效反超帧数 = 仲裁值 - 3"，
  // 1/2 基本反超不了晚到的类别、3 零宽限，故一律不允许（后端同样校验）
  if(arbFrames !== 0 && (arbFrames < 4 || arbFrames > 10)){ toast('仲裁帧数只能设 0（关闭）或 4～10'); return; }
  fetch('/api/arm/class-trigger-rules', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({rules: rules, mode: mode,
                          tuning: {arb_frames: arbFrames}})
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){
      _ind.triggerRules = res.rules || rules;
      _ind.triggerMode = (res.mode === 'advanced') ? 'advanced' : 'basic';
      if(res.tuning){
        _ind.triggerTuning = {
          arb_frames: res.tuning.arb_frames,
        };
      }
      // 切到高级规则时预热组映射：候选筛选在高级行程模式下要用 _ag.classGroupMap
      if(_ind.triggerMode === 'advanced'){ agLoadGroups(function(){}); }
      _ind._trDraft = null;
      // 规则已存：新配置即时生效，旧累计/窗口作废；并归零冷却计时——
      // 用户显式改了冷却值，旧的 last 不能倒追到新窗口（否则"改完第一次"被挡）
      indInvalidateTrigger(true);
      indRenderTriggerSummary();
      closeModal('trigger-rules-modal');
      toast('触发规则已保存');
    } else {
      toast(res.msg || '保存失败', 'error');
    }
  }).catch(function(){ toast('请求失败', 'error'); });
}

// 恢复默认：只把弹窗重置为默认态（模式=普通规则、表格按默认值重渲染、仲裁=6），
// 不落库——与模式切换/表格编辑统一，点「保存」才生效（2026-10-22 改；
// 旧实现立即 POST 但不刷新弹窗 UI，表现为"仲裁回不到 6、模式按钮不变"）
function indResetTriggerRules(){
  confirmDialog('恢复默认触发规则',
    '将清空全部类别触发规则、退回「普通规则」模式、仲裁恢复默认 6 帧。需点「保存」后生效，确定吗？',
    function(){
      _ind._trDraft = { mode: 'basic' };
      indRefreshTriggerRules(true);      // 按默认值重渲染表格（不动已生效配置）
      trRenderModeDesc();
      var arbEl = document.getElementById('tr-arb-frames');
      if(arbEl) arbEl.value = 6;
      toast('已重置为默认，记得点「保存」');
    });
}

// 仅报警：不驱动机械臂，画面红框闪烁 + 顶部醒目横条 + 写一条记录（不弹窗打断）
function indShowAlarm(cls, conf){
  var box = document.getElementById('ind-cam-box');
  if(box){
    box.style.transition = 'none';
    box.style.boxShadow = '0 0 0 3px rgba(226,75,74,.9)';
    box.style.borderRadius = '10px';
    var n = 0;
    if(_ind._alarmTimer) clearInterval(_ind._alarmTimer);
    _ind._alarmTimer = setInterval(function(){
      n++;
      box.style.boxShadow = (n % 2 === 0)
        ? '0 0 0 3px rgba(226,75,74,.9)'
        : '0 0 0 3px rgba(226,75,74,.15)';
      if(n >= 12){   // 闪烁约 6 轮后停
        clearInterval(_ind._alarmTimer);
        _ind._alarmTimer = null;
        box.style.boxShadow = 'none';
      }
    }, 250);
  }
  var bar = document.getElementById('ind-alarm-bar');
  if(bar){
    bar.innerHTML = '⚠ 检测到 <b>' + cls + '</b>（置信度 ' + conf.toFixed(2) +
                 '）· 仅报警，未执行分拣';
    bar.style.display = '';
  }
  // 写一条报警记录（复用分拣记录表，界面不用改；失败不影响报警提示）
  fetch('/api/arm/alarm-record', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({defect_class: cls, confidence: conf})
  }).catch(function(){});
}

function indCloseAlarm(){
  var bar = document.getElementById('ind-alarm-bar');
  if(bar) bar.style.display = 'none';
  var box = document.getElementById('ind-cam-box');
  if(box) box.style.boxShadow = 'none';
  if(_ind._alarmTimer){ clearInterval(_ind._alarmTimer); _ind._alarmTimer = null; }
}

// ===== 自动分拣（占位，后端 sorter.py 后续实现） =====
function indSorterToggle(){
  if(_ind.sorterRunning){
    indSorterStop();
  } else {
    indSorterStart();
  }
}

function indStartSorterPoll(){
  indStopSorterPoll();
  _ind._sorterTimer = setInterval(indSorterPoll, 800);
  indSorterPoll();
}

function indStopSorterPoll(){
  if(_ind._sorterTimer){ clearInterval(_ind._sorterTimer); _ind._sorterTimer = null; }
}

function indSorterPoll(){
  if(!_ind.sorterRunning) return;
  // 1. 如果机械臂空闲且有最新检测结果，推送触发分拣
  if(!_ind.sorterBusy && _ind.latestDetection){
    var det = _ind.latestDetection;
    _ind.latestDetection = null;
    fetch('/api/sorter/detect', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({defect_class: det.defect_class, confidence: det.confidence})
    }).then(function(r){return r.json();}).then(function(res){
      // 高级模式下 res.busy 是普通模式分拣的状态（恒为 false），
      // 必须用 res.run.running 判断动作组是否真的启动了，否则类别记不下来
      var triggered = res.ok && (res.busy || (res.run && res.run.running));
      var _stT = _ind.triggerState || {};
      var _stCls = _stT[det.defect_class];
      if(triggered){
        // 提名被接受：冷却在此正式起算（只在接受时写 last，避免仲裁窗内每帧刷新 last
        // 把高优先级类自家冷却挡在候选池外）；同时清零该类防抖计数。
        if(_stCls){ _stCls.last = Date.now() / 1000; _stCls.frames = 0; }
        _ind.sorterBusy = true;
        _ind.sorterPhase = res.current_phase || 'picking';
        // 记下本轮触发类别与映射去向：遮罩文字用（"识别到 X → 正在分拣/运行动作组"）
        _ind.lastTriggerClass = det.defect_class;
        var _pk = (_ind.classMap || {})[det.defect_class] || '';
        // 显示汉字标签（如「放置位1」），不显示 place_mv7vyqab_0 这类内部 key
        _ind.lastTriggerPlace = _pk ? ((getPoseList().find(function(p){ return p.key === _pk; }) || {}).label || _pk) : '';
      }
      // 提名被拒（后端双校验未过：动作组仍在跑/类别未映射等）：本次不算触发，
      // 冷却不起算（本就不在挑选阶段写 last），无需回滚。
      // 同一条提示只弹一次：未映射类别若反复被推送，Toast 会一直刷屏
      if(!res.ok && res.msg){
        if(!_ind._notifiedMsgs) _ind._notifiedMsgs = {};
        if(!_ind._notifiedMsgs[res.msg]){
          _ind._notifiedMsgs[res.msg] = true;
          toast(res.msg);
        }
      }
      indUpdateSorterStatus(res);
    }).catch(function(){});
    return;
  }
  // 2. 否则查询状态
  fetch('/api/sorter/status').then(function(r){return r.json();}).then(function(res){
    if(res.ok) indUpdateSorterStatus(res);
  }).catch(function(){});
}

function indUpdateSorterStatus(res){
  // ⚠ 高级模式下 res.busy（普通模式分拣状态）恒为 false——只看它会让 sorterBusy
  // 在动作组整轮运行期间被状态轮询刷回 false，挑选/推送管线重新打开，
  // 每秒重提一次全被后端双校验拒绝（实测 47 次/分钟）。
  // 必须与 run.running 合并判定（与下方 _ind.busy 同口径）
  _ind.sorterBusy = !!(res.busy || (res.run && res.run.running));
  _ind.sorterPhase = res.current_phase;
  _ind.estop = res.estop;
  _ind.sorterRunning = res.running;
  // 分拣/动作组忙碌同步到机械臂状态；刚刚跑完（true→false）时全部失效，见下方
  var wasBusy = _ind.busy;
  _ind.busy = !!(res.busy || (res.run && res.run.running));
  if(wasBusy && !_ind.busy && _ind.sorterRunning){ indInvalidateTrigger(); }
  indUpdateUI();
  indUpdatePoseBtns();
  var statusEl = document.getElementById('sorter-status-text');
  var cls = _ind.lastTriggerClass || '';
  var maskBusy = false, maskText = '', maskStep = 0, maskTotal = 0, maskLabel = '';
  if(statusEl){
    if(res.estop){
      statusEl.textContent = '状态：已急停，请点击复位';
      statusEl.style.color = '#e0655a';
    } else if(res.stop_requested && res.busy){
      statusEl.textContent = '状态：完成当前动作后停止...';
      statusEl.style.color = '';
      maskBusy = true;
    } else if(res.running && res.busy){
      // ---- 普通模式：固定 5 步 ----
      var phaseLabels = {idle:'待机', picking:'移动到抓取位', sucking:'吸气抓取',
                         placing:'移动到放置位', releasing:'放气释放', returning:'返回原点'};
      var pl = phaseLabels[res.current_phase] || res.current_phase;
      statusEl.textContent = '状态：' + pl + '...';
      statusEl.style.color = '';
      maskBusy = true;
      // 遮罩信息补全：识别到的类别 + 映射到的放置位
      maskText = cls ? ('分拣「' + cls + '」' + (_ind.lastTriggerPlace ? (' → ' + _ind.lastTriggerPlace) : '')) : '正在执行分拣动作...';
      maskStep = res.step || 0;
      maskTotal = res.step_total || 0;
      maskLabel = pl;
    } else if(res.run && res.run.running){
      // ---- 高级模式：运行动作组（原先没有遮罩）----
      var gn = res.run.group_name || '';
      statusEl.textContent = '状态：运行动作组「' + gn + '」...';
      statusEl.style.color = '';
      _ind._runWasActive = true;      // 完成时据此弹通知（普通模式走 last_result）
      maskBusy = true;
      maskText = (cls ? ('识别「' + cls + '」 → ') : '') + '动作组「' + gn + '」';
      maskStep = res.run.step || 0;
      maskTotal = res.run.step_total || 0;
      maskLabel = res.run.label || '';
    } else if(res.run && !res.run.running && !res.run.error && _ind._runWasActive){
      // 高级模式：动作组刚跑完 → 弹完成通知（原先只有普通模式有）
      _ind._runWasActive = false;
      // 与普通模式的完成通知保持同一格式：「分拣完成「类别」 → 目标」
      toast('分拣完成「' + (res.run && res.run.trigger_class ? res.run.trigger_class : cls) + '」 → 动作组「' + (res.run.group_name || '') + '」', 'success');
    } else if(res.run && res.run.error && _ind._runWasActive){
      _ind._runWasActive = false;
      // 急停/主动停止令动作组以 error='已中止' 收场，这不算"运行失败"：
      // 前端急停时已弹过"已急停"，这里再弹会把急停 toast 盖掉；
      // 且急停后轮询停转时 _runWasActive 可能残留，下次点启动会补弹一次"已中止"
      if(res.run.error !== '已中止' && !_ind.estop){
        toast('动作组运行失败：' + res.run.error, 'error');   // toast 只认 success/error/warning
      }
    } else if(res.running){
      statusEl.textContent = '状态：等待检测目标...';
      statusEl.style.color = '';
    } else {
      statusEl.textContent = '状态：未启动';
      statusEl.style.color = '';
    }
  }
  // 统一遮罩：普通/高级都显示，且带「停止分拣 / 紧急停止」按钮
  if(maskBusy){
    showLoading(maskText || '正在执行分拣动作...', 120);
    // maskTotal 为 0 = 动作组刚启动、步骤数还没算出来（正在解析动作组）
    // —— 文案要写清楚这是"准备"，否则会显示成孤零零的"准备中"，看着莫名其妙
    if(maskTotal) setLoadStep(maskStep, maskTotal, maskLabel);
    else setLoadProgress(0, 0, '正在解析动作组…');
    indEnsureMaskActions();
  } else {
    hideLoading();
    indHideMaskActions();
  }
  indUpdateSorterBtn();
  // 检测到新的分拣结果，刷新右栏
  if(res.last_result && res.last_result.timestamp){
    var t = new Date(res.last_result.timestamp).getTime();
    if(t > (_ind._lastSortResultTime || 0)){
      _ind._lastSortResultTime = t;
      indLoadSortStats();
      indLoadSortRecords(true);   // 保留当前页码：否则每分拣完成一轮都会把记录列表踢回第 1 页
      if(res.last_result.success){
        toast('分拣完成「' + res.last_result.defect_class + '」 → ' + res.last_result.place_label, 'success');
      } else if(!_ind.estop){
        // 急停期间产生的失败记录（被中止）不再弹"分拣失败"，避免与"已急停"toast 叠加
        toast('分拣失败：' + (res.last_result.error || '未知错误'), 'err');
      }
    }
  }
}

function indUpdateSorterBtn(){
  var btn = document.getElementById('sorter-toggle-btn');
  var estopBtn = document.getElementById('sorter-estop-btn');
  var resetBtn = document.getElementById('sorter-reset-btn');
  if(!btn) return;
  if(_ind.estop){
    // 急停状态：启动按钮禁用，急停按钮禁用，复位按钮启用
    btn.textContent = '已急停';
    btn.className = 'btn';
    btn.style.background = '#5a3a3a';
    btn.style.color = '#999';
    btn.disabled = true;
    if(estopBtn) estopBtn.disabled = true;
    if(resetBtn){ resetBtn.disabled = false; resetBtn.style.borderColor = '#c9986b'; resetBtn.style.color = '#c9986b'; }
  } else if(_ind.sorterRunning){
    btn.textContent = '停止分拣';
    btn.className = 'btn';
    btn.style.background = '#e0655a';
    btn.style.color = '#fff';
    btn.style.fontWeight = '700';
    btn.disabled = !_ind.connected;
    if(estopBtn) estopBtn.disabled = !_ind.connected;
    if(resetBtn){ resetBtn.disabled = true; resetBtn.style.borderColor = ''; resetBtn.style.color = ''; }
  } else {
    btn.textContent = '启动自动分拣';
    btn.className = 'btn btn-primary';
    btn.style.background = '';
    btn.style.color = '';
    btn.style.fontWeight = '700';
    btn.disabled = !_ind.connected;
    if(estopBtn) estopBtn.disabled = true;
    if(resetBtn){ resetBtn.disabled = true; resetBtn.style.borderColor = ''; resetBtn.style.color = ''; }
  }
}

function indSorterStart(){
  // 逐项检查
  var missing = [];
  if(!_ind.connected) missing.push('机械臂未连接');
  if(!_ind.cameraOn) missing.push('摄像头未开启');
  if(!_ind.inferOn) missing.push('推理未开启');
  // 检查5个标定位
  var needed = getPoseList().map(function(p){ return p.key; });
  var missingPoses = [];
  needed.forEach(function(n){
    if(!(_ind.poses && _ind.poses[n] && _ind.poses[n].calibrated)){
      var label = (getPoseList().find(function(p){return p.key===n;})||{}).label || n;
      missingPoses.push(label);
    }
  });
  if(missingPoses.length) missing.push('标定位未完成: ' + missingPoses.join('、'));
  if(missing.length){
    toast(missing.join('；'));
    return;
  }
  showLoading('正在启动自动分拣...', 20);
  fetch('/api/sorter/start', {method:'POST'})
    .then(function(r){return r.json();})
    .then(function(res){
      hideLoading();
      if(res.ok){
        _ind.sorterRunning = true;
        _ind.latestDetection = null;
        _ind._pendingClass = null;
        indInvalidateTrigger();   // 新一轮分拣：旧累计/窗口全部失效，避免拿旧候选开窗
        indUpdateSorterBtn();
        indSyncStatusPoll();     // 开始用机械臂 → 状态轮询提速
        indStartSorterPoll();
        toast(res.msg || '自动分拣已启动');
      } else {
        toast(res.msg || '启动失败');
      }
    })
    .catch(function(){ hideLoading(); toast('启动请求失败'); });
}

function indSorterStop(){
  // 不做二次确认：遮罩上的停止按钮必须一点就停（确认弹窗 z-index 低于加载遮罩会被盖住点不到）
  fetch('/api/sorter/stop', {method:'POST'})
    .then(function(r){return r.json();})
    .then(function(res){
      _ind.sorterRunning = false;
      indInvalidateTrigger();   // 停止分拣：防抖累计+仲裁窗全部失效（不补触发）
      indUpdateSorterBtn();
      indSyncStatusPoll();     // 停用机械臂 → 状态轮询降回心跳
      toast(res.msg || '已请求停止');
    })
    .catch(function(){ toast('停止请求失败'); });
}

function indEStopSorter(){
  // 不做二次确认：紧急停止必须一点就停
  // （遮罩上的"紧急停止"按钮也走这里，保证 toast 只弹一次、不会多路通知互相覆盖）
  fetch('/api/sorter/estop', {method:'POST'})
      .then(function(r){return r.json();})
      .then(function(res){
        _ind.sorterRunning = false;
        _ind.sorterBusy = false;
        _ind.sorterPhase = 'idle';
        _ind.estop = true;
        // 急停会让动作组以 error='已中止' 收场：提前清掉标记，
        // 轮询就不会把"已中止"当运行失败再弹一次 toast
        _ind._runWasActive = false;
        indInvalidateTrigger();   // 急停：防抖累计+仲裁窗全部失效（现场状态已作废）
        indUpdateSorterBtn();
        // 立即收掉遮罩与按钮：急停后机械臂已停，不能让遮罩挡着页面
        hideLoading();
        indHideMaskActions();
        toast(res.msg || '已急停', 'err');
      })
      .catch(function(){ toast('急停请求失败', 'err'); });
}

function indResetSorter(){
  showLoading('正在复位...', 20);
  fetch('/api/sorter/reset', {method:'POST'})
    .then(function(r){return r.json();})
    .then(function(res){
      hideLoading();
      _ind.estop = false;
      indInvalidateTrigger();   // 复位：重新来过，累计/窗口全部失效
      indUpdateSorterBtn();
      toast(res.msg || '已复位');
    })
    .catch(function(){ hideLoading(); toast('复位请求失败'); });
}

// ===== 分拣记录与统计 =====
function indSetStatsScope(scope){
  _ind.statsScope = (scope === 'me') ? 'me' : 'all';
  var mb = document.getElementById('scope-me-btn');
  var ab = document.getElementById('scope-all-btn');
  if(mb) mb.className = 'source-tab' + (_ind.statsScope === 'me' ? ' active' : '');
  if(ab) ab.className = 'source-tab' + (_ind.statsScope === 'all' ? ' active' : '');
  indLoadSortStats();
  indLoadSortRecords();
}

function indLoadSortStats(){
  var scope = _ind.statsScope || 'all';
  fetch('/api/sorter/stats?scope=' + scope).then(function(r){return r.json();}).then(function(res){
    if(res.ok){
      document.getElementById('sort-total').textContent = res.total || 0;
      var box = document.getElementById('sort-stats-box');
      if(box){
        while(box.children.length > 1) box.removeChild(box.lastChild);
        var classes = (_ind.selectedClasses && _ind.selectedClasses.length) ? _ind.selectedClasses : [];
        // 类别槽**固定 4 个**（用户要求）：不足的用占位卡补齐，
        // 这样统计区高度恒定，记录列表的可用高度不随类别数变化
        for(var i = 0; i < 4; i++){
          var cls = classes[i];
          var div = document.createElement('div');
          div.className = 'ind-metric';
          // flex-basis 50% 保证两列排布
          div.style.cssText = 'flex:1 1 calc(50% - 5px)' + (cls ? '' : ';opacity:.45');
          var label = cls || '未选择';
          var val = cls ? ((res.by_class && res.by_class[cls]) || 0) : '—';
          div.innerHTML = '<div class="m-lbl">'+label+'</div><div class="m-val">'+val+'</div><div class="m-sub">'+(cls?'件':'待选')+'</div>';
          box.appendChild(div);
        }
      }
    }
  }).catch(function(){});
}

function indRefreshClassFilter(){
  var sel = document.getElementById('sort-class-filter');
  if(!sel) return;
  var cur = sel.value;
  sel.innerHTML = '<option value="">全部类别</option>';
  ((_ind.selectedClasses && _ind.selectedClasses.length) ? _ind.selectedClasses : []).forEach(function(cls){
    var opt = document.createElement('option');
    opt.value = cls;
    opt.textContent = cls;
    sel.appendChild(opt);
  });
  sel.value = cur;
}

// append=true 表示"滚动到底加载下一页"：追加到列表末尾，不清空已有内容与勾选
var _REC_PAGE_SIZE = 50;

function indLoadSortRecords(append){
  indRefreshClassFilter();
  if(!append){ _ind._recPage = 1; }
  var page = _ind._recPage || 1;
  var cls = document.getElementById('sort-class-filter').value;
  var scope = _ind.statsScope || 'all';
  var url = '/api/sorter/records?page=' + page + '&page_size=' + _REC_PAGE_SIZE +
            '&scope=' + scope + (cls ? '&class=' + encodeURIComponent(cls) : '');
  fetch(url).then(function(r){return r.json();}).then(function(res){
    _ind._recLoading = false;
    var box = document.getElementById('sort-records-list');
    if(!box) return;
    if(!res.ok || !res.records || !res.records.length){
      _ind._recTotal = 0;
      box.innerHTML = '<div style="color:var(--text-3);font-size:12px">暂无记录</div>';
      indRenderSortRecordsPager();
      return;
    }
    box.innerHTML = '';
    _ind._recChecked = {};                 // 翻页后清空勾选，避免残留已不存在的 id
    _ind._recIds = [];                     // 本页记录 id：供「全选」使用
    indUpdateSortDelBtn();
    res.records.forEach(function(r){
      _ind._recIds.push(r.id);
      var div = document.createElement('div');
      div.style.cssText = 'font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;align-items:center';
      var time = r.created_at ? String(r.created_at).replace('T',' ').slice(0,19) : '';
      var clsColor = r.defect_class==='Dent' ? '#c9986b' : r.defect_class==='Hole' ? '#5a8fc9' : '#c96b6b';
      // 中列显示分三种情况（place_area 存的可能是放置位 key，也可能是动作组名）：
      //   ① 放置位还在 → 汉字标签（如「放置位1」）
      //   ② 放置位已被删除 → 标记「已删除」，不能误判成动作组
      //      （放置位 key 固定以 place_ 开头，据此区分；删除后列表里查不到但仍是放置位）
      //   ③ 其余 → 高级模式记录的动作组名，加「动作组」前缀
      var pv = r.place_area || '';
      var placeShown = '';
      var placeStale = false;
      if(pv){
        var hit = null;
        (getPoseList() || []).forEach(function(p){ if(p.key === pv) hit = p; });
        if(hit && hit.label){
          placeShown = hit.label;
        } else if(/^place_/.test(pv) || pv === 'home' || pv === 'pick'){
          // 放置位数据还没加载完时不判"已删除"——否则会把还在的放置位误标为已删除，
          // 等数据到位重刷后又变回汉字（同一条记录前后显示不一致）
          if(_ind.areasLoaded){
            placeShown = '已删除';        // 曾经的放置位，现已不存在
            placeStale = true;
          } else {
            placeShown = '';              // 数据未就绪：先留空，避免误判
          }
        } else if(/^\d+$/.test(pv)){
          // 存的是**动作组 id**：实时查组名，改名后立刻显示新名字
          var _g = (_ag.groups || []).filter(function(x){ return String(x.id) === pv; })[0];
          placeShown = _g ? ('动作组「' + _g.name + '」') : ('动作组 #' + pv);
        } else {
          placeShown = '动作组「' + pv + '」';   // 旧记录（存的是名字快照）
        }
      }
      // 三列布局：左（类别+置信）固定宽度不换行；中（去向）flex:1 占满剩余、
      // 超出省略号（防止超长文字换行把行撑乱）；右（时间）固定不换行。
      // 编辑模式下前面还有复选框，中列有 flex:1 会自动让位，不会挤占结构。
      // 中列：外层 flex:1 + text-align:center 让短文字居中；
      // 内层 inline-block + max-width:100% + ellipsis —— 文字超长时省略号生效，
      // 居中与省略号两全（直接在 flex 子项上又 center 又 ellipsis 会导致省略号不显示）
      div.innerHTML = '<span style="flex-shrink:0;white-space:nowrap"><span style="color:'+clsColor+';font-weight:600">'+(r.defect_class||'--')+'</span> ' +
        (r.confidence ? (r.confidence*100).toFixed(0)+'%' : '') + '</span>' +
        '<span style="flex:1;min-width:0;text-align:center;color:var(--text-3)'+(placeStale ? ';opacity:.55' : '')+'"' +
          (placeStale ? ' title="该放置位已被删除"' : '')+'>' +
          '<span style="display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'+(placeStale ? ';text-decoration:line-through' : '')+
          '">'+placeShown+'</span></span>' +
        '<span style="flex-shrink:0;white-space:nowrap;color:var(--text-3);font-family:monospace;font-size:11px">'+time+'</span>';
      // 勾选框与删除按钮：仅在「编辑模式」下出现，
      // 与检测历史 / 反馈管理等处的交互保持一致，避免平时误触
      if(_ind.sortEditing){
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.cssText = 'margin-right:6px;cursor:pointer;flex-shrink:0';
        cb.checked = !!_ind._recChecked[r.id];
        cb.onchange = function(){ indToggleRecCheck(r.id, cb.checked); };
        div.insertBefore(cb, div.firstChild);

        var del = document.createElement('span');
        del.textContent = '×';
        del.title = '删除这条分拣记录';
        del.style.cssText = 'cursor:pointer;color:#e0655a;font-weight:700;padding:0 4px;flex-shrink:0';
        del.onclick = function(e){ e.stopPropagation(); indDeleteSortRecord(r.id); };
        div.appendChild(del);
      }
      box.appendChild(div);
    });
    _ind._recTotal = (typeof res.total === 'number') ? res.total : _ind._recIds.length;
    // 分页控件：与检测历史 / 反馈管理保持同款交互
    indRenderSortRecordsPager();
  }).catch(function(){ _ind._recLoading = false; });
}

// ===== 分拣记录翻页（与检测历史 / 反馈管理一致的分页控件）=====
function indRenderSortRecordsPager(){
  var pager = document.getElementById('sort-records-pager');
  if(!pager) return;
  var total = _ind._recTotal || 0;
  var page = _ind._recPage || 1;
  var limit = _REC_PAGE_SIZE;
  var pages = Math.max(1, Math.ceil(total / limit));
  if(total === 0){ pager.innerHTML = '共 0 条'; return; }
  pager.innerHTML =
    '<button class="pg-btn"'+(page<=1?' disabled':'')+' onclick="indGoSortRecordsPage('+(page-1)+')">上一页</button>'+
    '<span class="pg-info">第 '+page+' / '+pages+' 页 · 共 '+total+' 条</span>'+
    '<button class="pg-btn"'+(page>=pages?' disabled':'')+' onclick="indGoSortRecordsPage('+(page+1)+')">下一页</button>';
}

function indGoSortRecordsPage(p){
  var pages = Math.max(1, Math.ceil((_ind._recTotal || 0) / _REC_PAGE_SIZE));
  _ind._recPage = Math.min(pages, Math.max(1, p));
  // 必须传 append=true 保留刚设置的页码：不传会被 indLoadSortRecords 重置回第 1 页
  // （表现为"下一页"点了永远停在第 1 页）
  indLoadSortRecords(true);
}

// ===== 分拣遮罩上的操作按钮 =====
// 遮罩全屏盖住页面，若不放按钮，机械臂动作中点不到「停止/急停」
function indEnsureMaskActions(){
  var act = document.getElementById('loading-actions');
  if(!act) return;
  // 分拣遮罩只放「停止分拣/紧急停止」：显式藏掉检测任务共用的「后台推理/终止推理」，
  // 否则之前后台推理留下的残留按钮会跟着容器一起显示出来
  var bgBtn = document.getElementById('loading-bg');
  var ccBtn = document.getElementById('loading-cancel');
  if(bgBtn) bgBtn.style.display = 'none';
  if(ccBtn) ccBtn.style.display = 'none';
  if(act.dataset.ready){ act.style.display = 'flex'; return; }
  act.dataset.ready = '1';
  var b1 = document.createElement('button');
  b1.className = 'btn btn-ghost';
  b1.style.cssText = 'flex:1;padding:8px';
  b1.textContent = '停止分拣';
  b1.onclick = function(){ hideLoading(); indSorterStop(); };
  var b2 = document.createElement('button');
  b2.className = 'btn btn-ghost';
  b2.style.cssText = 'flex:1;padding:8px;color:#e0655a;border-color:rgba(224,101,90,.4)';
  b2.textContent = '紧急停止';
  b2.onclick = function(){
    // 紧急情况不弹确认，直接停；与 indEStopSorter 同一路径，toast 只弹一次
    indEStopSorter();
  };
  act.appendChild(b1);
  act.appendChild(b2);
  act.style.display = 'flex';
}

function indHideMaskActions(){
  var act = document.getElementById('loading-actions');
  if(act) act.style.display = 'none';
}

// ===== 分拣记录删除 =====

function indToggleRecCheck(id, checked){
  if(!_ind._recChecked) _ind._recChecked = {};
  if(checked) _ind._recChecked[id] = true;
  else delete _ind._recChecked[id];
  indUpdateSortDelBtn();
}

function indUpdateSortDelBtn(){
  var btn = document.getElementById('sort-del-batch-btn');
  if(!btn) return;
  var n = Object.keys(_ind._recChecked || {}).length;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? ('删除(' + n + ')') : '删除';   // 短文案，避免按钮挤爆筛选行
}

function indToggleSortRecordsEdit(){
  _ind.sortEditing = !_ind.sortEditing;
  var eb = document.getElementById('sort-edit-btn');
  var db = document.getElementById('sort-del-batch-btn');
  var sa = document.getElementById('sort-select-all-btn');
  if(eb) eb.textContent = _ind.sortEditing ? '完成' : '编辑';
  if(db) db.style.display = _ind.sortEditing ? 'inline-block' : 'none';
  if(sa) sa.style.display = _ind.sortEditing ? 'inline-block' : 'none';
  if(!_ind.sortEditing) _ind._recChecked = {};
  indLoadSortRecords();
}

// 全选 / 取消全选（编辑模式下）：针对当前列表里的记录
function indSelectAllRecords(){
  var ids = _ind._recIds || [];
  if(!ids.length){ toast('当前没有可勾选的记录'); return; }
  var all = ids.every(function(id){ return _ind._recChecked[id]; });
  if(all){
    _ind._recChecked = {};
  } else {
    ids.forEach(function(id){ _ind._recChecked[id] = true; });
  }
  // 同步 UI 复选框
  document.querySelectorAll('#sort-records-list input[type=checkbox]').forEach(function(cb){
    cb.checked = !all;
  });
  indUpdateSortDelBtn();
  toast(all ? '已取消全选' : '已全选 ' + ids.length + ' 条记录');
}

function indDeleteSortRecordsBatch(){
  var ids = Object.keys(_ind._recChecked || {}).map(Number);
  if(!ids.length){ toast('请先勾选要删除的记录'); return; }
  confirmDialog('批量删除', '确定删除选中的 <b>' + ids.length + '</b> 条分拣记录吗？<br>删除后「今日分拣统计」的计数会同步减少。', function(){
    fetch('/api/sorter/records', {
      method:'DELETE', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ids: ids})
    }).then(function(r){ return r.json(); }).then(function(res){
      if(!res.ok){ toast(res.msg || '批量删除失败'); return; }
      toast('已删除 ' + ids.length + ' 条记录');
      _ind._recChecked = {};
      indLoadSortRecords();      // 刷新记录列表
      indLoadSortStats();        // 刷新今日计分统计
    }).catch(function(err){
      // 删除可能已经生效，先核实一次再报错，避免"其实删了却显示失败"
      var purged = Object.keys(_ind._recChecked || {}).map(Number);
      toast('删除失败（' + ((err && err.message) || '网络错误') + '）');
      console.error('[删除分拣记录失败]', err, purged);
      indLoadSortRecords();
    });
  });
}

function indDeleteSortRecord(rid){
  confirmDialog('删除记录', '确定删除这条分拣记录吗？<br>删除后「今日分拣统计」的计数会同步减少。', function(){
    fetch('/api/sorter/records/' + rid, {method:'DELETE'})
      .then(function(r){ return r.json(); })
      .then(function(res){
        if(!res.ok){ toast(res.msg || '删除失败'); return; }
        toast('已删除');
        indLoadSortRecords();      // 刷新记录列表
        indLoadSortStats();        // 刷新今日计分统计
      })
      .catch(function(){ toast('请求失败'); });
  });
}

// ===== 页面初始化 =====
function indCheckAndEnter(){
  // 确认弹窗已经显示时，不重复请求和弹窗（避免全局5秒同步定时器重置倒计时）
  var cm = document.getElementById('confirm-modal');
  if(cm && cm.classList.contains('show')) return;
  // 每次进入工控页都请求锁（页面初始化只做一次）
  fetch('/api/arm/page/enter', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({device_id: indGetDeviceId()})})
    .then(function(r){return r.json();})
    .then(function(res){
      if(res.ok){
        _ind.pageLocked = true;
        indStartPageHeartbeat();
        if(!_ind._initialized){
          indInitPage();
          _ind._initialized = true;
        } else {
          // 再次进入（切走又切回）：定时器已被 indStopAllTimers() 清掉，必须重新保活
          indEnsureAuxTimers();
          indFetchStatus();
        }
      } else {
        var owner = res.owner || '其他用户';
        confirmDialogCountdown('页面使用中',
          '当前气泵吸盘机械臂页面正被 <b>' + owner + '</b> 使用中。<br><br>该页面同一时间仅允许一个设备操作，请待对方使用完毕后再进入。',
          10, function(){ go('dash'); }, true);
      }
    })
    .catch(function(){
      // 接口失败时，如果已初始化就刷新状态，否则初始化
      if(_ind._initialized){ indEnsureAuxTimers(); indFetchStatus(); }
      else { indInitPage(); _ind._initialized = true; }
    });
}

function indInitPage(){
  // 初始状态：摄像头未开启，隐藏画面底部信息条
  var metaInit = document.querySelector('#ind-cam-box .cam-meta');
  if(metaInit) metaInit.style.display = 'none';
  indUpdateCamUI();
  // 先用当前值（默认 standard）渲染一次选中态：
  // 配置是异步拉取的，等接口返回才渲染的话，那一小段时间三个档位全是空白、
  // 看不出选了哪个（网络慢时尤其明显）。配置回来后 indLoadArmConfig 会再校正。
  indRenderMoveSpeed();
  indLoadArmConfig();
  // 预加载动作组列表：分拣记录里存的是**动作组 id**，显示时要用 id 查组名。
  // 原先只在"模式切换"或"打开编辑器"时才加载 —— 首次进入页面时 _ag.groups 为空，
  // 记录会先显示「动作组 #12」，加载后才变成「动作组「wjk」」，
  // 表现为"刷新后同一条记录显示成另一个文本"。
  agLoadGroups(function(){ indRenderClasses(); indLoadSortRecords(); });
  indRefreshPorts();
  indRenderJoints();
  indRenderPoseBtns();
  indUpdateUI();
  indLoadSortStats();
  indLoadSortRecords();
  indLoadCurrentModel();
  indEnsureAuxTimers();
  // 立即同步后端连接状态（刷新页面后无需等待轮询）
  indFetchStatus();
  _ind._initialized = true;
}

// 轻量轮询当前模型名：只查库，不触发模型加载。
// 名字没变就什么都不做；变了才调 indLoadCurrentModel 取完整信息（类别名等）。
// 这样管理员在别处切换模型后，工控页 3 秒内就能跟上，且不会反复加载模型。
function indPollModelName(){
  if(!state.currentUser) return;
  fetch('/api/models/current-name').then(function(r){ return r.json(); }).then(function(res){
    if(res.ok && res.name && res.name !== _ind.curModel){
      _ind.curModel = res.name;
      indLoadCurrentModel();
      // 模型换了 -> 重新读取"该模型自己的"类别映射（后端按模型分别保存），
      // 否则界面上还是上一个模型的映射
      indLoadArmConfig();
      if(agIsAdvanced()) agLoadGroups();
    }
  }).catch(function(){});
}

function indEnsureAuxTimers(){
  // 辅助轮询：当前模型(5s) + 统计与记录(20s)。
  // 幂等：已存在则原样保留，不会重复创建。
  // 必须在【每次进入工控页】都调用一次 —— 离开工控页时 indStopAllTimers() 会清掉这些定时器，
  // 而 indInitPage() 只在首次进入时执行，若不保活，切走再切回来就再也不会自动刷新了。
  if(!_ind._modelTimer){
    // 轮询走**轻量接口**（只查库、不加载模型），且间隔缩到 3s：
    // 原先每 5s 直接调 indLoadCurrentModel（内含 /api/models/current，需加载模型
    // 取类别名），冷启动/大模型时会拖慢，管理员切换后显示明显滞后。
    _ind._modelTimer = setInterval(indPollModelName, 3000);
  }
  // 统计与记录**拆成两个定时器**：
  // 统计数字要跟得上分拣节奏（5s，查询很轻）；
  // 记录列表每次要拉 50 条，刷新太频繁没意义且增加负担（15s）。
  if(!_ind._statsTimer){
    _ind._statsTimer = setInterval(indLoadSortStats, 5000);
  }
  if(!_ind._refreshTimer){
    _ind._refreshTimer = setInterval(indLoadSortRecords, 15000);
  }
}

function indStartPageHeartbeat(){
  if(_ind._pageHeartbeatTimer) clearInterval(_ind._pageHeartbeatTimer);
  _ind._pageHeartbeatTimer = setInterval(function(){
    fetch('/api/arm/page/heartbeat', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
      .then(function(r){
        if(r.status === 403){
          indStopPageHeartbeat();
          toast('您的模块访问权限已被撤销');
          go('dash');
          return null;
        }
        return r.json();
      })
      .then(function(res){
        if(!res) return;
        if(!res.ok){
          indStopPageHeartbeat();
          confirmDialogCountdown('已被移出',
            '您已被移出气泵吸盘机械臂页面，可能是其他用户抢占了该页面，或您的连接已超时。',
            10, function(){ go('dash'); }, true);
        }
      })
      .catch(function(){});
  }, 5000);
}

function indStopPageHeartbeat(){
  if(_ind._pageHeartbeatTimer){
    clearInterval(_ind._pageHeartbeatTimer);
    _ind._pageHeartbeatTimer = null;
  }
}

function indReleasePageLock(){
  if(!_ind.pageLocked) return;
  _ind.pageLocked = false;
  indStopPageHeartbeat();
  try{
    // keepalive fetch 比 sendBeacon 更可靠，页面关闭时也能发出去
    fetch('/api/arm/page/leave', {
      method:'POST', keepalive:true,
      headers:{'Content-Type':'application/json'}, body:'{}'
    }).catch(function(){});
  }catch(e){
    try{ navigator.sendBeacon('/api/arm/page/leave', ''); }catch(e2){}
  }
}
function indStopAllTimers(){
  // 离开工控页 / 页面刷新前统一清理所有轮询定时器，避免离页后仍后台轮询（定时器泄漏）
  if(_ind.statusTimer){ clearInterval(_ind.statusTimer); _ind.statusTimer = null; }
  if(_ind.webcamTimer){ clearInterval(_ind.webcamTimer); _ind.webcamTimer = null; }
  if(_ind._sorterTimer){ clearInterval(_ind._sorterTimer); _ind._sorterTimer = null; }
  if(_ind._modelTimer){ clearInterval(_ind._modelTimer); _ind._modelTimer = null; }
  if(_ind._statsTimer){ clearInterval(_ind._statsTimer); _ind._statsTimer = null; }
  if(_ind._refreshTimer){ clearInterval(_ind._refreshTimer); _ind._refreshTimer = null; }
  if(_ind._pageHeartbeatTimer){ clearInterval(_ind._pageHeartbeatTimer); _ind._pageHeartbeatTimer = null; }
  if(_ind.pumpCountdownTimer){ clearInterval(_ind.pumpCountdownTimer); _ind.pumpCountdownTimer = null; }
}

// ===== 弹窗 / 抽屉 =====
function openPwModal(){ document.getElementById('pw-modal').classList.add('show'); }
function closeModal(id){ document.getElementById(id).classList.remove('show'); }
var _confirmCb=null;
var _confirmCountdownTimer=null;
function confirmDialogCountdown(title, msg, seconds, cb, hideCancel){
  confirmDialog(title, msg, cb);
  var cancelBtn = document.querySelector('#confirm-modal .btn-ghost');
  if(cancelBtn) cancelBtn.style.display = hideCancel ? 'none' : '';
  var btn = document.getElementById('confirm-ok');
  var remain = seconds;
  btn.textContent = '确定（' + remain + 's）';
  if(_confirmCountdownTimer) clearInterval(_confirmCountdownTimer);
  _confirmCountdownTimer = setInterval(function(){
    remain--;
    if(remain <= 0){
      clearInterval(_confirmCountdownTimer);
      _confirmCountdownTimer = null;
      btn.click();
    } else {
      btn.textContent = '确定（' + remain + 's）';
    }
  }, 1000);
}
function confirmDialog(title, msg, cb){
  document.getElementById('confirm-title').textContent=title||'操作确认';
  document.getElementById('confirm-msg').innerHTML=msg||'确定要执行此操作吗？';
  _confirmCb=cb;
  document.getElementById('confirm-modal').classList.add('show');
}
function closeConfirm(){
  if(_confirmCountdownTimer){
    clearInterval(_confirmCountdownTimer);
    _confirmCountdownTimer = null;
  }
  var btn = document.getElementById('confirm-ok');
  if(btn) btn.textContent = '确定';
  var cancelBtn = document.querySelector('#confirm-modal .btn-ghost');
  if(cancelBtn) cancelBtn.style.display = '';
  document.getElementById('confirm-modal').classList.remove('show');
  _confirmCb=null;
}
document.getElementById('confirm-ok').onclick=function(){
  var cb=_confirmCb;
  closeConfirm();
  if(typeof cb==='function') cb();
};

var _promptCb=null;
function promptDialog(title, placeholder, cb, defaultValue){
  document.getElementById('prompt-title').textContent=title||'请输入';
  var input=document.getElementById('prompt-input');
  input.value=defaultValue||'';
  input.placeholder=placeholder||'';
  _promptCb=cb;
  document.getElementById('prompt-modal').classList.add('show');
  setTimeout(function(){input.focus();},120);
}
function closePrompt(){
  document.getElementById('prompt-modal').classList.remove('show');
  _promptCb=null;
}
document.getElementById('prompt-ok').onclick=function(){
  var val=document.getElementById('prompt-input').value.trim();
  var cb=_promptCb;
  closePrompt();
  if(typeof cb==='function') cb(val);
};
document.getElementById('prompt-input').addEventListener('keydown',function(e){
  if(e.key==='Enter') document.getElementById('prompt-ok').click();
});
function openDetail(rid){
  var r = (state.records||[]).find(function(x){return x.id===rid});
  if(!r) return;
  document.getElementById('detail-time').textContent = '检测时间：' + r.created_at;
  document.getElementById('detail-filename').textContent = r.image_name || '(视频)';
  // 图片 or 视频
  var isVideo = (r.result_url || '').toLowerCase().endsWith('.mp4') || (r.image_name||'').toLowerCase().endsWith('.mp4');
  // 结论：与检测页共用同一套统一模板（历史记录无帧数字段，视频时自动省略「共 F 帧」段）
  document.getElementById('detail-conclusion').textContent = buildDetectSummary(r, isVideo);
  var origImg = document.getElementById('detail-orig');
  var origVid = document.getElementById('detail-orig-video');
  var origCap = document.getElementById('detail-orig-cap');
  var resImg = document.getElementById('detail-result');
  var resImgCv = document.getElementById('detail-result-img-canvas');
  var resVideo = document.getElementById('detail-result-video');
  document.getElementById('detail-result-cap').textContent = isVideo ? '标注视频' : '结果图';
  // 「点下载时才现场把框绘制进去」属实现说明，只留代码注释不进页面（与检测页下载按钮口径一致）
  document.getElementById('detail-download-wrap').innerHTML =
    '<button class="btn btn-ghost btn-sm" onclick="downloadMarked(' + r.id + ', this)">下载标注' +
    (isVideo ? '视频' : '图片') + '</button>';
  if(isVideo){
    // 左列：原视频本体（磁盘上不再有封面帧）。两个视频都自动循环播放并同步进度
    origCap.textContent = '原视频';
    origImg.style.display = 'none';
    if(resImgCv) resImgCv.style.display = 'none';
    origVid.style.display = 'block';
    origVid.muted = true;           // 必须静音，浏览器才允许自动播放
    if(origVid.getAttribute('src') !== API + r.source_url){
      origVid.src = API + r.source_url;
      origVid.load();
    }
    resImg.style.display = 'none';
    resVideo.style.display = 'block';
    var dvb = document.getElementById('detail-result-box-canvas');
    if(dvb) dvb.style.display = 'none';
    resVideo._boxTimeline = null;   // 先清掉上一条记录的时间轴，加载成功后再挂新的
    resVideo.muted = true;
    // 结果侧一律播**原视频 + 前端逐帧画框**（磁盘上不再有标注 mp4）
    resVideo.src = API + (r.source_url || r.result_url);
    resVideo.load();
    if(r.boxes_url){ detailLoadBoxes(r.boxes_url); }
    detailAutoPlayBoth();
  } else {
    origCap.textContent = '原图';
    origVid.pause(); origVid.removeAttribute('src'); origVid.load();
    origVid.style.display = 'none';
    origImg.style.display = 'block';
    if(r.image_url){ origImg.src = API + r.image_url; }
    resImg.style.display = 'block';
    resVideo.style.display = 'none';
    resVideo.removeAttribute('src');
    resVideo.load();
    // 结果图 = 原图 + 前端现场画框（磁盘上不再有带框结果图）
    if(resImgCv){
      resImgCv.style.display = (r.boxes && r.boxes.length) ? 'block' : 'none';
      if(resImgCv.getContext){ var g0 = resImgCv.getContext('2d'); g0.clearRect(0,0,resImgCv.width,resImgCv.height); }
    }
    resImg.onload = function(){ drawDetailImgBoxes(resImg, resImgCv, r.boxes); };
    resImg.src = API + (r.image_url || r.result_url);
    if(resImg.complete && resImg.naturalWidth){ drawDetailImgBoxes(resImg, resImgCv, r.boxes); }
  }
  // 目标数
  // 统计信息（按类别数量）
  var sw = document.getElementById('detail-stats-wrap');
  var chips = [];
  for(var cls in r.stats){
    chips.push('<span style="display:inline-block;padding:4px 12px;margin:0 6px 6px 0;border-radius:14px;background:rgba(201,152,107,.12);color:var(--accent);font-size:13px">'+cls+'：'+r.stats[cls]+'</span>');
  }
  sw.innerHTML = chips.length
    ? '<div style="font-size:13px;color:var(--text-3);margin-bottom:6px">统计信息</div>'+chips.join('')
    : '';
  // 明细表说明：与检测页同一套文案（图片=逐框明细 / 视频=全片按类别聚合），不再只给视频显示
  setTblNote(isVideo ? 'agg' : 'frames', (r.boxes||[]).length, 'detail-tbl-note');
  // boxes 明细表（视频记录无逐帧明细）
  var tbody = document.getElementById('detail-tbody');
  tbody.innerHTML = '';
  (r.boxes||[]).forEach(function(b){
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>'+b.cls_name+'</td><td>'+b.conf+'</td><td>'+
      b.x1+', '+b.y1+', '+b.x2+', '+b.y2+'</td>';
    tbody.appendChild(tr);
  });
  document.getElementById('detail-mask').classList.add('show');
  document.getElementById('detail-drawer').classList.add('show');
  renderDetailChart(r);
}
// 详情页图片：在原图上现场画框（数据来自记录里的 boxes，原图空间坐标）
function drawDetailImgBoxes(imgEl, cv, boxes){
  if(!imgEl || !cv) return;
  var bd = {boxes: boxes, iw: imgEl.naturalWidth, ih: imgEl.naturalHeight};
  cv._boxData = (boxes && boxes.length) ? bd : null;   // 供 Lightbox 点图放大时重画
  if(!boxes || !boxes.length || !imgEl.naturalWidth) return;
  var bw = imgEl.clientWidth, bh = imgEl.clientHeight;
  if(!bw || !bh) return;
  var sc = bw / imgEl.naturalWidth;
  var dpr = window.devicePixelRatio || 1;
  var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
  if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, bw, bh);
  drawBoxesCore(g, boxes, sc, 2, 12, 1);
}

// 详情页两个视频：自动循环播放 + 进度同步（以左侧原视频为准），关闭抽屉即停
var _detailSyncRAF = null;
function detailAutoPlayBoth(){
  var a = document.getElementById('detail-orig-video');
  var b = document.getElementById('detail-result-video');
  [a, b].forEach(function(v){
    if(!v) return;
    v.muted = true;
    v.loop = true;
    var p = v.play();
    if(p && p.catch){ p.catch(function(){}); }   // 自动播放被拦也不影响手动点开
  });
  if(!_detailSyncRAF){ _detailSyncRAF = requestAnimationFrame(detailSyncLoop); }
}
function detailSyncLoop(){
  var a = document.getElementById('detail-orig-video');
  var b = document.getElementById('detail-result-video');
  if(a && b && a.duration && b.duration && !a.paused && !a.seeking && !b.seeking){
    if(Math.abs(a.currentTime - b.currentTime) > 0.3){ b.currentTime = a.currentTime; }
  }
  _detailSyncRAF = requestAnimationFrame(detailSyncLoop);
}
function detailStopBoth(){
  if(_detailSyncRAF){ cancelAnimationFrame(_detailSyncRAF); _detailSyncRAF = null; }
  ['detail-orig-video', 'detail-result-video'].forEach(function(id){
    var v = document.getElementById(id);
    if(!v) return;
    v.pause();
    v.removeAttribute('src');   // 清掉源，彻底释放解码/缓冲（下次打开会重新赋值）
    v.load();
  });
}

// 历史详情：加载视频框时间轴并启动逐帧画框循环
state.detailVideoActive = false;
state.detailVideoBoxes = null; state.detailVideoFps = 25; state.detailVideoW = 0; state.detailVideoH = 0; state.detailVideoNames = {};
function detailLoadBoxes(boxesUrl){
  var v = document.getElementById('detail-result-video');
  var cv = document.getElementById('detail-result-box-canvas');
  state.detailVideoActive = true;
  state.detailVideoBoxes = null;
  fetch(API + boxesUrl, {credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(tl){
      if(!state.detailVideoActive) return;
      state.detailVideoBoxes = tl.frames || [];
      state.detailVideoFps = tl.fps || 25;
      state.detailVideoW = tl.width || 0;
      state.detailVideoH = tl.height || 0;
      state.detailVideoNames = tl.names || {};
      if(cv) cv.style.display = state.detailVideoBoxes.length ? 'block' : 'none';
      v._boxTimeline = {boxes: state.detailVideoBoxes, fps: state.detailVideoFps,
                        w: state.detailVideoW, h: state.detailVideoH, names: state.detailVideoNames};
      detailVideoLoop();
    })
    .catch(function(){ if(cv) cv.style.display = 'none'; });
}
function detailVideoLoop(){
  if(!state.detailVideoActive) return;
  var v = document.getElementById('detail-result-video');
  var cv = document.getElementById('detail-result-box-canvas');
  if(v && cv){
    var bw = v.clientWidth, bh = v.clientHeight;
    if(bw && bh && state.detailVideoBoxes && state.detailVideoBoxes.length && v.duration){
      var fw = state.detailVideoW || v.videoWidth, fh = state.detailVideoH || v.videoHeight;
      if(fw && fh){
        var sc = Math.min(bw / fw, bh / fh);
        var ox = (bw - fw * sc) / 2, oy = (bh - fh * sc) / 2;
        var dpr = window.devicePixelRatio || 1;
        var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
        if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
        var g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, bw, bh);
        var idx = Math.round((v.currentTime || 0) * state.detailVideoFps);
        if(idx < 0) idx = 0;
        if(idx >= state.detailVideoBoxes.length) idx = state.detailVideoBoxes.length - 1;
        var arr = state.detailVideoBoxes[idx] || [];
        if(arr.length){
          var boxes = arr.map(function(a){
            return {cls: a[0], cls_name: state.detailVideoNames[String(a[0])] || String(a[0]),
                    conf: a[1], x1: a[2], y1: a[3], x2: a[4], y2: a[5]};
          });
          drawBoxesCore(g, boxes, sc, 2, 12, 1, ox, oy);
        }
      }
    }
  }
  requestAnimationFrame(detailVideoLoop);
}
function closeDetail(){
  state.detailVideoActive = false;   // 停掉详情视频的逐帧画框循环
  detailStopBoth();                  // 关闭抽屉 → 两侧视频停止播放
  // 放大层若还开着（详情页里点画面进去的）一并关掉，否则原声会在后台继续播
  var lb = document.getElementById('lightbox');
  if(lb && lb.style.display === 'flex'){ closeLightbox(); }
  document.getElementById('detail-mask').classList.remove('show');
  document.getElementById('detail-drawer').classList.remove('show');
}
function delRow(btn, rid){
  confirmDialog('删除检测记录','确定要删除这条检测记录吗？删除后不可恢复。', function(){
    showLoading('正在删除记录...', 30);
    _delWithRetry('/api/history/'+rid, {method:'DELETE'},
      function(){
        if(btn.closest('tr')) btn.closest('tr').remove();
        // 单行删除后同样要把该 id 从勾选集里踢掉，避免残留计数
        if(state.historyCheckedIds) delete state.historyCheckedIds[rid];
        syncHistoryCheckAll();
        updateHistoryDelBtn();
        toast('记录已删除');
      }, '删除失败',
      function(done){ verifyHistoryDeleted([rid], done); });
  });
}

// ===== Toast =====
var toastTimer=null;
function toast(msg, type){
  var t=document.getElementById('toast');
  var txt=document.getElementById('toast-text');
  txt.textContent=msg;
  // 类型着色：success=绿，error=红，warning=橙
  txt.style.color = '';
  if(type==='success') txt.style.color = '#5aa96c';
  else if(type==='error') txt.style.color = '#e57373';
  else if(type==='warning') txt.style.color = '#e8a33d';
  t.style.display='flex';
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){
    t.style.display='none';
    txt.style.color='';
  }, 2800);
}

// ===== 全局加载遮罩 =====
var _loadTimer=null, _loadStallTimer=null, _loadMax=0, _loadLast=0;
function showLoading(text, timeoutSec){
  var t=document.getElementById('loading-text');
  if(t) t.textContent = text || '正在处理，请稍候...';
  var prog=document.getElementById('loading-progress');
  if(prog) prog.style.display='none';
  var fill=document.getElementById('lp-fill');
  if(fill){ fill.style.width='0'; fill.className='lp-fill'; }
  var sub=document.getElementById('lp-sub');
  if(sub) sub.textContent='';
  var note=document.getElementById('loading-note');
  if(note){ note.style.display='none'; note.textContent=''; }
  document.getElementById('loading-mask').style.display='flex';
  clearLoadingTimers();
  _loadMax=0;
  if(timeoutSec && timeoutSec>0){
    _loadTimer=setTimeout(function(){
      var n=document.getElementById('loading-note');
      if(n){ n.style.display='block'; n.textContent='等待超时，操作可能仍在后台进行，可稍候或刷新后到历史记录查看'; }
    }, timeoutSec*1000);
  }
}
function clearLoadingTimers(){
  if(_loadTimer){ clearTimeout(_loadTimer); _loadTimer=null; }
  if(_loadStallTimer){ clearTimeout(_loadStallTimer); _loadStallTimer=null; }
}
function setLoadProgress(done, total, subText){
  var prog=document.getElementById('loading-progress');
  var fill=document.getElementById('lp-fill');
  var sub=document.getElementById('lp-sub');
  if(!prog||!fill) return;
  prog.style.display='flex';
  if(total && total>0){
    var pct=Math.max(0, Math.min(100, Math.round(done/total*100)));
    if(pct<_loadMax) pct=_loadMax;      // 进度只增不减
    _loadMax=pct;
    fill.className='lp-fill';
    fill.style.width=pct+'%';
    if(sub) sub.textContent=(subText||'')+' '+pct+'%';
  }else{
    fill.className='lp-fill indeterminate';   // 总数未知：不确定动画
    fill.style.width='';
    if(sub) sub.textContent=subText||('已处理 '+done);
  }
  // 停滞检测：进度长时间不变时给温和提示（不是硬性超时）
  if(_loadStallTimer) clearTimeout(_loadStallTimer);
  _loadLast=done;
  _loadStallTimer=setTimeout(function(){
    var n=document.getElementById('loading-note');
    if(n && _loadMax<100){ n.style.display='block'; n.textContent='处理似乎变慢了…仍在继续，可稍候或刷新后到历史记录查看'; }
  }, 30000);
}
function setLoadStep(step, total, label){
  var prog=document.getElementById('loading-progress');
  var fill=document.getElementById('lp-fill');
  var sub=document.getElementById('lp-sub');
  if(!prog||!fill||!total) return;
  prog.style.display='flex';
  var pct=Math.max(_loadMax, Math.round(step/total*100));
  _loadMax=pct;
  fill.className='lp-fill';
  fill.style.width=pct+'%';
  if(sub) sub.textContent='步骤 '+step+' / '+total+(label?('：'+label):'');
}
function hideLoading(){
  clearLoadingTimers();
  document.getElementById('loading-mask').style.display='none';
}

// ===== 滚动位置记忆（刷新后原地恢复上次停留位）=====
// 视图记忆本来就有（URL hash，route() 负责恢复），但 go() 在路由时会 scrollTo(0,0)，
// 会杀掉浏览器原生的刷新恢复；因此把 history.scrollRestoration 设为 'manual'，
// 改由这里完全控制，刷新时原地恢复到位（无"先回顶再滚回"的跳动）。
//   · 滚动停下 150ms 后，按当前视图写入 sessionStorage；
//   · 仅"首次路由"（刷新/直接打开链接）时恢复，应用内跳转债照旧回顶部；
//   · 恢复时机自适应：长列表页（模型/历史/训练/用户/文章等）首屏是空容器，
//     内容靠 fetch 异步拉取后才长高，故每帧检查，内容够高（maxY>=y）就滚动到记忆位
//     并停止，否则等下一帧（最多 ~2s）覆盖异步渲染；
//   · 仅在"真实用户滚动意图"（滚轮 / 触摸滑动 / 翻页方向键）时取消恢复，
//     不用 'scroll' 事件，避免自身 scrollTo 或浏览器原生恢复误杀。
var _scrollMemPrefix = 'wb_scroll_';
var _scrollSaveTimer = null;
var _initialRouting = true;       // 启动后的第一次 route() 视为"刷新恢复"
var _scrollRestoreToken = 0;
// 关闭浏览器原生滚动恢复，改由 restoreScrollPos 完全控制（见上方说明）
if('scrollRestoration' in history){ history.scrollRestoration = 'manual'; }

function _scrollMemKey(view){ return _scrollMemPrefix + (view || 'home'); }

window.addEventListener('scroll', function(){
  if(_scrollSaveTimer) return;
  _scrollSaveTimer = setTimeout(function(){
    _scrollSaveTimer = null;
    try{
      var v = (location.hash || '#home').replace('#','') || 'home';
      sessionStorage.setItem(_scrollMemKey(v), String(Math.round(window.scrollY || 0)));
    }catch(e){}
  }, 150);
}, {passive:true});

function restoreScrollPos(view){
  var token = ++_scrollRestoreToken;
  var y = 0;
  try{ y = parseInt(sessionStorage.getItem(_scrollMemKey(view)) || '0', 10) || 0; }catch(e){}
  if(!(y > 0)) return;                       // 该视图无记忆则跳过
  var frames = 0;
  // 仅在"真实用户滚动意图"时取消恢复：滚轮 / 触摸滑动 / 翻页方向键；
  // 不用 'scroll' 事件，避免我们自己的 scrollTo(0,y) 或浏览器原生恢复误杀。
  var cleanup = function(){
    window.removeEventListener('wheel', cancel, {passive:true});
    window.removeEventListener('touchmove', cancel, {passive:true});
    window.removeEventListener('keydown', onKey, true);
  };
  var cancel = function(){ token = -1; cleanup(); };
  var onKey = function(e){
    if(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown','Space'].indexOf(e.code) >= 0) cancel();
  };
  window.addEventListener('wheel', cancel, {passive:true});
  window.addEventListener('touchmove', cancel, {passive:true});
  window.addEventListener('keydown', onKey, true);
  var step = function(){
    if(token !== _scrollRestoreToken){ cleanup(); return; }   // 被新路由 / 用户主动滚动取消
    var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if(maxY >= y){                            // 内容已够高（含异步 fetch 长高后），原地恢复到位
      window.scrollTo(0, y);
      cleanup();
      return;
    }
    if(frames++ < 120) requestAnimationFrame(step);   // 否则等下一帧（最多 ~2s）覆盖异步渲染
    else cleanup();
  };
  requestAnimationFrame(step);
}

// ===== hash 路由 =====
var _rawHashBeforeRoute = '';   // route() 改写前抓下的原始 hash（深链要用）
function route(){
  var h=(location.hash||'#home').replace(/^#\/?/, '');
  var allowed=['home','login','register','dash','detect','industrial','extensions','models','train','history','articles','users','articles-admin','profile','feedback'];
  if(allowed.indexOf(h)<0) h='home';
  // 原始 hash 必须在 go() 改写之前抓下来 —— go() 内部会 replaceState 成 '#'+view，
  // 未登录时受保护页面还会被顶成 login，目标视图就丢了。
  _rawHashBeforeRoute = location.hash || '';
  // 已登录用户访问根/首页/登录/注册页，自动进工作台
  if(state.currentUser && (h==='home' || h==='login' || h==='register')){
    h='dash';
  }
  go(h);
  if(h==='home'){ requestAnimationFrame(observeReveal); }
  _initialRouting = false;   // 首次路由（刷新/直接打开）结束，之后的跳转债照旧回顶部
  applyDeepLink();
}

// ===== 深链：外部（如汇报 PPT）通过 ?open=xxx 直接打开指定页面/弹窗 =====
// 用法： http://127.0.0.1:5000/?open=trigger#/industrial
//   ⚠ 查询参数必须在 hash 之前！写成 #/industrial?open=trigger 的话，
//     ?open=trigger 会变成 hash 的一部分，location.search 取不到，深链失效。
//   open=trigger   触发逻辑配置弹窗   open=ag      动作组编辑器
//   open=roi       工控页识别区域       open=dataset 数据集自动划分弹窗
//   open=weights   预训练权重弹窗
// 每个深链目标的「真实入口按钮」查找器
var _DEEP_TARGETS = {
  'trigger': function(){ return document.querySelector('[onclick="openTriggerRules()"]'); },
  'ag':      function(){
    // 动作组编辑器只在「高级模式」下可见（按钮 display:none），且 agOpenEditor 内部
    // 也会检查 agIsAdvanced()。深链要先切到高级模式，再点开编辑器。
    var b = document.getElementById('ag-open-editor-btn');
    if(!b) return false;
    if(typeof agIsAdvanced === 'function' && !agIsAdvanced()){
      if(typeof agSetMode === 'function'){
        agSetMode(true);   // 异步：切完 agOnModeChanged 会把按钮显示出来
        return false;     // 本轮先不点，下一轮轮询时按钮已可见
      }
    }
    if(b.style.display === 'none') b.style.display = '';
    return b;
  },
  'dataset': function(){
    var sel = document.getElementById('tf-dataset');
    if(!sel) return false;
    // 自动划分要求先在下拉框选中一个「尚未划分」的数据集，否则 openDatasetSplitDialog
    // 会 toast 提示后直接 return。深链场景帮他选一个 train_count 为 0 的数据集。
    if(!sel.value){
      var ds = (trainDatasets || []).filter(function(d){ return !d.train_count; })[0]
            || (trainDatasets || [])[0];
      if(ds && ds.name) sel.value = ds.name;
    }
    var b = document.querySelector('[onclick="openDatasetSplitDialog()"]');
    return b || false;
  },
  'weights': function(){ return document.querySelector('[onclick="openBackboneFetchDialog()"]'); },
};
// 打开触发逻辑弹窗有前置条件：必须先在上方「类别选择」里勾选过类别，
// 否则 openTriggerRules() 会 toast 提示后直接 return，弹窗根本开不出来。
// 深链场景下用户是"来演示这个功能"的，帮他把当前模型的类别自动勾上再开弹窗。
var _deepClassFetching = false;   // 防重入：正在异步取类别时不要再发一次请求
function ensureClassesSelected(){
  try{
    if(!_ind) return false;
    var sel = _ind.selectedClasses || [];
    if(sel.length) return true;
    // ① 工控页已加载过模型 → 直接用 _ind.modelClasses
    var names = (_ind.modelClasses || []).slice();
    if(names.length){
      _ind.selectedClasses = names;
      if(typeof indRefreshTriggerRules === 'function') indRefreshTriggerRules();
      if(typeof indRenderClasses === 'function') indRenderClasses();
      return true;
    }
    // ② 工控页还没加载完 → 直接问后端要当前模型的类别
    if(_deepClassFetching) return false;
    _deepClassFetching = true;
    fetch('/api/models/current').then(function(r){return r.json();}).then(function(res){
      try{
        if(res.ok && res.model && res.model.classes && res.model.classes.length){
          _ind.modelClasses = res.model.classes;
          _ind.selectedClasses = res.model.classes.slice();
          if(typeof indRefreshTriggerRules === 'function') indRefreshTriggerRules();
          if(typeof indRenderClasses === 'function') indRenderClasses();
          // 类别补齐后重新点一次，弹窗就能开出来
          var b = _DEEP_TARGETS['trigger'] ? _DEEP_TARGETS['trigger']() : null;
          if(b) b.click();
        }
      }catch(e){}
    }).catch(function(){}).then(function(){ _deepClassFetching = false; });
    return false;
  }catch(e){ console.warn('ensure classes failed:', e); return false; }
}
// 处理完立即从 URL 上抹掉 ?open=，避免刷新时重复弹。
// 每个 handler 都走「点真实界面按钮」而不是直接调内部函数 ——
// 内部函数常带前置条件（如动作组编辑器要求高级模式），
// 点按钮能自动走完那些前置流程，与用户现场手动操作完全一致。
var _DEEP_HANDLERS = {
  'trigger': function(){
    var b = document.querySelector('[onclick="openTriggerRules()"]');
    if(b) b.click();
  },
  'ag':      function(){
    var b = document.getElementById('ag-open-editor-btn');
    if(b){ if(b.style.display === 'none') b.style.display = ''; b.click(); }
  },
  'roi':     function(){
    // 识别区域（ROI）是工控页实时画面上直接拖拽框选的，没有独立弹窗 ——
    // 深链只负责把页面切到工控页并滚到实时视觉推理区，框选由用户现场拖。
    setTimeout(function(){
      var el = document.getElementById('ind-cam-box') || document.getElementById('view-industrial');
      if(el && el.scrollIntoView) el.scrollIntoView({block:'center'});
    }, 700);
  },
  'dataset': function(){
    var b = document.querySelector('[onclick="openDatasetSplitDialog()"]');
    if(b) b.click();
  },
  'weights': function(){
    var b = document.querySelector('[onclick="openBackboneFetchDialog()"]');
    if(b) b.click();
  },
};
// 待执行的深链：若跳转过来时未登录，页面会被重定向到登录页，
// 这里先把目标存下来，登录成功后由 onLoggedIn 补跳（演示时 session 过期也能落到目标页）。
var _pendingDeep = null;
function applyDeepLink(){
  var q = location.search || '';
  var m = /[?&]open=([a-z_-]+)/i.exec(q);
  if(!m) return;
  var key = m[1].toLowerCase();
  // 抹掉 URL 上的 open 参数（用 replaceState，不触发 hashchange）
  try{
    var clean = location.pathname + location.hash;
    history.replaceState(null, '', clean);
  }catch(e){}
  if(!_DEEP_HANDLERS[key]) return;
  // 未登录：route() 会把 hash 改写成 #login 或 #home（PROTECTED 页面会被顶掉），
  // 所以目标视图必须**在改写前**抓下来 —— 否则登录后不知道该跳哪一页。
  // 注意 hash 可能带前导斜杠（#/industrial 这种写法），要规范化掉。
  if(!state.currentUser){
    var raw = (_rawHashBeforeRoute || '').replace(/^#\/?/, '');
    var target = raw && raw !== 'login' && raw !== 'home' && raw !== 'register' ? raw : '';
    _pendingDeep = { key: key, hash: target ? ('#' + target) : '' };
    return;
  }
  runDeepLink(key);
}
function runDeepLink(key){
  var fn = _DEEP_HANDLERS[key];
  if(!fn) return;
  // 走「轮询等待真实按钮」路径，保证前置条件（高级模式、数据加载）都满足
  if(_DEEP_TARGETS[key]){
    waitDeepTarget(key, 12);
    return;
  }
  try{ fn(); }catch(e){ console.warn('deep link error:', key, e); }
}
// 登录成功后补跳：先切到目标视图，再执行弹窗指令
function resumePendingDeep(){
  if(!_pendingDeep) return;
  var p = _pendingDeep; _pendingDeep = null;
  try{
    if(p.hash && p.hash !== location.hash){
      location.hash = p.hash;               // 触发 route() → go(视图)
      // 视图切换后入口按钮要等一会儿才在 DOM 里就绪（还要等工控页的数据加载），
      // 所以轮询等待，最多重试 3 秒。
      waitDeepTarget(p.key, 12);
    }else{
      runDeepLink(p.key);
    }
  }catch(e){ console.warn('resume deep link error:', e); }
}
// 轮询等待深链目标按钮就绪再点击（工控页/训练页的按钮要等数据加载完才有意义）
function waitDeepTarget(key, tries){
  if(tries <= 0){ console.warn('deep link target not ready:', key); return; }
  setTimeout(function(){
    var b = _DEEP_TARGETS[key] ? _DEEP_TARGETS[key]() : null;
    if(b === false){
      // 目标尚未就绪（需要先切模式/等数据），下一轮再试
      waitDeepTarget(key, tries - 1);
      return;
    }
    if(b){
      try{
        // 触发逻辑弹窗要先有勾选类别，否则点了只会弹 toast
        if(key === 'trigger'){
          if(!ensureClassesSelected()){
            // 类别还没就绪（要等模型加载），下一轮再试
            waitDeepTarget(key, tries - 1);
            return;
          }
        }
        b.click();
      }catch(e){ console.warn('deep link click error:', e); }
    }else{
      waitDeepTarget(key, tries - 1);
    }
  }, 260);
}
window.addEventListener('hashchange',route);

// ===== 滚动渐入 =====
var io=null;
function observeReveal(){
  if(!('IntersectionObserver' in window)){
    document.querySelectorAll('.reveal').forEach(function(el){el.classList.add('visible')});
    return;
  }
  if(io) io.disconnect();
  io=new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  },{threshold:.15,rootMargin:'0px 0px -40px 0px'});
  document.querySelectorAll('.reveal:not(.visible)').forEach(function(el){io.observe(el)});
}

// ===== 数字滚动 =====
function animateCount(el){
  var target=parseFloat(el.getAttribute('data-target'));
  var dec=parseInt(el.getAttribute('data-decimal')||'0');
  var dur=1400, start=null;
  function step(ts){
    if(!start) start=ts;
    var p=Math.min((ts-start)/dur,1);
    var ease=1-Math.pow(1-p,3);
    var val=target*ease;
    el.textContent=dec>0 ? val.toFixed(dec) : Math.round(val).toLocaleString();
    if(p<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function observeCounts(){
  if(!('IntersectionObserver' in window)){
    document.querySelectorAll('.count').forEach(function(el){el.textContent=el.getAttribute('data-target')});
    return;
  }
  var cio=new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        animateCount(e.target);
        cio.unobserve(e.target);
      }
    });
  },{threshold:.5});
  document.querySelectorAll('.count').forEach(function(el){cio.observe(el)});
}

// ===== 启动：检查登录态 =====
api('/api/me').then(function(res){
  if(res.data.ok){
    state.currentUser = res.data.user;
    updateChromeUser();
    // 自动恢复登录态，欢迎回来
    toast('欢迎回来，'+res.data.user.username+'！', 'success');
  }
  route();
  // 深链：若启动时已登录（session 有效），route() 里的 applyDeepLink 会直接执行；
  // 若未登录，applyDeepLink 已把目标存进 _pendingDeep，等登录成功后补跳。
}).catch(function(){
  route();
});
applyDetectConfDefaults();   // 整页加载时拉取后端默认置信度并预填一次（仅此一次）
observeReveal();
observeCounts();

// ==================== 用户管理 ====================
state.users = [];
state.usersEditing = false;
state.usersCheckedIds = {};
function loadUsers(){
  api('/api/users').then(function(res){
    if(!res.data.ok){ if(res.status===401){ go('login'); } return; }
    state.users = res.data.users || [];
    renderUsers();
  });
}
function renderUsers(){
  var tbody = document.getElementById('users-tbody');
  if(!tbody) return;
  var kw = (document.getElementById('user-search')||{value:''}).value.trim().toLowerCase();
  var role = (document.getElementById('user-role-filter')||{value:'all'}).value;
  var rows = state.users.filter(function(u){
    if(role!=='all' && u.role!==role) return false;
    if(kw && (u.username||'').toLowerCase().indexOf(kw)<0 && (u.phone||'').indexOf(kw)<0) return false;
    return true;
  });
  tbody.innerHTML='';
  rows.forEach(function(u){
    var tr=document.createElement('tr');
    var roleText = u.role==='admin' ? '管理员' : '普通用户';
    var statusBadge;
    if(u.status==='disabled'){
      statusBadge = '<span class="status-badge" style="color:#e57373">已拉黑</span>';
    } else if(u.online){
      statusBadge = '<span class="status-badge" style="color:#5aa96c">在线</span>';
    } else {
      statusBadge = '<span class="status-badge" style="color:var(--text-3)">离线</span>';
    }
    var lastCol;
    if(u.status==='disabled'){
      lastCol = '<span style="color:var(--text-3)">—</span>';
    } else if(u.online){
      lastCol = '<span style="color:#5aa96c">● '+(u.device||'设备')+' 在线</span>';
    } else {
      lastCol = '<span style="color:var(--text-3)">最后在线：'+(u.last_seen||'—')+'</span>';
    }
    var dis = state.usersEditing ? '' : 'disabled';
    tr.innerHTML =
      '<td class="cb-col"><input type="checkbox" class="user-cb" value="'+u.id+'"'+(state.usersCheckedIds[u.id]?' checked':'')+' '+dis+' onchange="onUserCBClick('+u.id+', this.checked)"></td>'+
      '<td>'+u.username+'</td>'+
      '<td style="font-family:monospace;color:var(--text-2)">'+(u.phone||'—')+'</td>'+
      '<td style="font-family:monospace;color:var(--text-2)">'+(u.user_code||'—')+'</td>'+
      '<td>'+roleText+'</td>'+
      '<td>'+statusBadge+'</td>'+
      '<td>'+lastCol+'</td>'+
      '<td>'+(u.created_at||'')+'</td>'+
      '<td>'+(u.id===state.currentUser.id ? '<span style="color:var(--text-3)">（本人）</span>' : '<span class="op-link" onclick="openEditUserModal('+u.id+')">编辑</span>')+'</td>';
    tbody.appendChild(tr);
  });
  document.getElementById('user-count').textContent = rows.length;
  var ca = document.getElementById('users-checkall');
  if(ca){ ca.disabled = !state.usersEditing; ca.checked = Object.keys(state.usersCheckedIds).length === rows.length && rows.length > 0; }
}
function onUserCBClick(id, checked){
  if(checked) state.usersCheckedIds[id] = true;
  else delete state.usersCheckedIds[id];
  var ca = document.getElementById('users-checkall');
  if(ca) ca.checked = Object.keys(state.usersCheckedIds).length === document.querySelectorAll('.user-cb').length;
}
function toggleUsersEdit(){
  state.usersEditing = !state.usersEditing;
  document.getElementById('btn-edit-users').textContent = state.usersEditing ? '完成' : '编辑';
  document.getElementById('btn-batch-del-users').style.display = state.usersEditing ? 'inline-block' : 'none';
  if(!state.usersEditing) state.usersCheckedIds = {};
  renderUsers();
}
function resetUserFilter(){
  document.getElementById('user-search').value='';
  document.getElementById('user-role-filter').value='all';
  renderUsers();
}
function delUser(id, name){
  confirmDialog('删除用户','确定要删除用户 <b style="color:var(--accent)">'+name+'</b> 吗？', function(){
    var token = sessionStorage.getItem('token');
    fetch(API + '/api/users/'+id, {method:'DELETE', credentials:'same-origin',
      headers: token?{'Authorization':'Bearer '+token}:{}})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.ok){ toast('已删除'); loadUsers(); } else toast(d.msg||'删除失败');
      });
  });
}
var editingUserId = null;
function openEditUserModal(uid){
  var u = state.users.find(function(x){return x.id===uid;});
  if(!u) return;
  editingUserId = uid;
  document.getElementById('eu-username').value = u.username;
  document.getElementById('eu-role').value = u.role;
  document.getElementById('eu-status').value = u.status || 'active';
  document.getElementById('edit-user-modal').classList.add('show');
}
function submitEditUser(){
  api('/api/users/'+editingUserId, {method:'PUT', body: JSON.stringify({
    role: document.getElementById('eu-role').value,
    status: document.getElementById('eu-status').value
  })})
    .then(function(res){
      if(res.data.ok){ closeModal('edit-user-modal'); toast('角色已更新'); loadUsers(); }
      else toast(res.data.msg||'更新失败');
    });
}
function deleteSelectedUsers(){
  var ids = Object.keys(state.usersCheckedIds).map(function(id){return +id;});
  if(!ids.length){ toast('请先勾选用户'); return; }
  confirmDialog('删除所选','确定要删除选中的 <b style="color:#e57373">'+ids.length+'</b> 个用户吗？', function(){
    api('/api/users/batch-delete', {method:'POST', body: JSON.stringify({ids:ids})})
      .then(function(res){
        if(res.data.ok){ toast('已删除 '+res.data.deleted+' 个用户'); state.usersCheckedIds = {}; loadUsers(); }
        else toast(res.data.msg||'删除失败');
      });
  });
}

// ==================== 文章管理（后台） ====================
state.articles = [];
state.articlesEditing = false;
state.articlesCheckedIds = {};
function loadArticles(){
  api('/api/articles').then(function(res){
    if(!res.data.ok){ if(res.status===401){ go('login'); } return; }
    state.articles = res.data.articles || [];
    renderArticles();
  });
}
function renderArticles(){
  var tbody = document.getElementById('articles-tbody');
  if(!tbody) return;
  var kw = (document.getElementById('article-search')||{value:''}).value.trim().toLowerCase();
  var st = (document.getElementById('article-status-filter')||{value:'all'}).value;
  var rows = state.articles.filter(function(a){
    if(st!=='all' && a.status!==st) return false;
    if(kw && (a.title||'').toLowerCase().indexOf(kw)<0) return false;
    return true;
  });
  tbody.innerHTML='';
  var dis = state.articlesEditing ? '' : 'disabled';
  rows.forEach(function(a){
    var tr=document.createElement('tr');
    var stText = a.status==='published' ? '已发布' : '草稿';
    tr.innerHTML =
      '<td class="cb-col"><input type="checkbox" class="article-cb" value="'+a.id+'"'+(state.articlesCheckedIds[a.id]?' checked':'')+' '+dis+' onchange="onArticleCBClick('+a.id+', this.checked)"></td>'+
      '<td title="'+a.title+'">'+(a.title||'').slice(0,40)+'</td>'+
      '<td>'+(a.summary||'').slice(0,60)+'</td>'+
      '<td>'+stText+'</td>'+
      '<td>'+(a.updated_at||a.created_at||'')+'</td>'+
      '<td><span class="op-link" onclick="openArticleModal('+a.id+')">编辑</span></td>';
    tbody.appendChild(tr);
  });
  if(!rows.length) tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:40px 0">暂无数据</td></tr>';
  document.getElementById('article-count').textContent = rows.length;
  var ca = document.getElementById('articles-checkall');
  if(ca){ ca.disabled = !state.articlesEditing; ca.checked = Object.keys(state.articlesCheckedIds).length === rows.length && rows.length > 0; }
}
function onArticleCBClick(id, checked){
  if(checked) state.articlesCheckedIds[id] = true;
  else delete state.articlesCheckedIds[id];
  var ca = document.getElementById('articles-checkall');
  if(ca) ca.checked = Object.keys(state.articlesCheckedIds).length === document.querySelectorAll('.article-cb').length;
}
function toggleArticlesEdit(){
  state.articlesEditing = !state.articlesEditing;
  document.getElementById('btn-edit-articles').textContent = state.articlesEditing ? '完成' : '编辑';
  document.getElementById('btn-batch-del-articles').style.display = state.articlesEditing ? 'inline-block' : 'none';
  if(!state.articlesEditing) state.articlesCheckedIds = {};
  renderArticles();
}
function resetArticleFilter(){
  document.getElementById('article-search').value='';
  document.getElementById('article-status-filter').value='all';
  renderArticles();
}
function deleteSelectedArticles(){
  var ids = Object.keys(state.articlesCheckedIds).map(function(id){return +id;});
  if(!ids.length){ toast('请先勾选文章'); return; }
  confirmDialog('删除所选','确定要删除选中的 <b style="color:#e57373">'+ids.length+'</b> 篇文章吗？', function(){
    api('/api/articles/batch-delete', {method:'POST', body: JSON.stringify({ids:ids})})
      .then(function(res){
        if(res.data.ok){ toast('已删除 '+res.data.deleted+' 篇文章'); state.articlesCheckedIds = {}; loadArticles(); }
        else toast(res.data.msg||'删除失败');
      });
  });
}

// ==================== 安全宣教（前台） ====================
state.pubArticles = [];
function loadPubArticles(){
  api('/api/articles/public').then(function(res){
    if(!res.data.ok) return;
    state.pubArticles = res.data.articles || [];
    renderPubArticles();
  });
}
function renderPubArticles(){
  var box = document.getElementById('pub-article-list');
  if(!box) return;
  var kw = (document.getElementById('pub-article-search')||{value:''}).value.trim().toLowerCase();
  var rows = state.pubArticles.filter(function(a){
    return !kw || (a.title||'').toLowerCase().indexOf(kw)>=0;
  });
  if(!rows.length){
    box.innerHTML = '<div class="empty-box-wrap"><div class="empty-txt">暂无文章内容</div></div>';
    return;
  }
  box.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">' +
    rows.map(function(a){
      return '<div onclick="openArticleDetail('+a.id+')" style="padding:18px;border:1px solid #2a2f38;border-radius:12px;background:#1b1f26;cursor:pointer;transition:.2s" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'#2a2f38\'">'+
        '<div style="font-weight:700;margin-bottom:8px">'+a.title+'</div>'+
        '<div style="color:var(--text-2);font-size:13px;line-height:1.6;min-height:42px">'+(a.summary||'暂无摘要')+'</div>'+
        '<div style="margin-top:12px;color:var(--text-3);font-size:12px">'+(a.category||'综合')+' · '+(a.author||'系统')+' · '+(a.created_at||'')+'</div>'+
      '</div>';
    }).join('') + '</div>';
}

function openArticleDetail(id){
  api('/api/articles/'+id).then(function(res){
    if(!res.data.ok){ toast(res.data.msg||'加载失败'); return; }
    var a = res.data.article;
    document.getElementById('ad-title').textContent = a.title;
    document.getElementById('ad-meta').textContent = (a.category||'综合')+' · '+(a.author||'系统')+' · '+(a.created_at||'');
    document.getElementById('ad-body').textContent = a.content || a.summary || '（暂无正文）';
    document.getElementById('article-detail-modal').classList.add('show');
  });
}

// ==================== 模型批量删除 ====================
state.modelsEditing = false;
state.modelCheckedIds = {};  // 跨渲染保留勾选状态 {id: true}
function toggleModelsEdit(){
  state.modelsEditing = !state.modelsEditing;
  document.getElementById('btn-edit-models').textContent = state.modelsEditing ? '完成' : '编辑';
  document.getElementById('btn-batch-del-models').style.display = state.modelsEditing ? 'inline-block' : 'none';
  document.getElementById('btn-checkall-models').style.display = state.modelsEditing ? 'inline-block' : 'none';
  if(!state.modelsEditing) state.modelCheckedIds = {};  // 退出编辑模式清空勾选
  renderModels();
  updateModelsCheckAllLabel();
}
function onModelCBClick(id, checked){
  if(checked) state.modelCheckedIds[id] = true;
  else delete state.modelCheckedIds[id];
  updateModelsCheckAllLabel();
}
function updateModelsCheckAllLabel(){
  var btn = document.getElementById('btn-checkall-models');
  if(!btn) return;
  var cbs = document.querySelectorAll('.model-cb');
  if(!cbs.length){ btn.textContent = '全选'; return; }
  var checkedCount = Object.keys(state.modelCheckedIds).filter(function(id){
    return Array.from(cbs).some(function(c){return c.value === id;});
  }).length;
  btn.textContent = (checkedCount === cbs.length) ? '取消全选' : '全选';
}
function toggleModelsCheckAll(){
  var cbs = document.querySelectorAll('.model-cb');
  var allChecked = Array.from(cbs).every(function(c){return c.checked;});
  cbs.forEach(function(c){
    c.checked = !allChecked;
    if(!allChecked) state.modelCheckedIds[c.value] = true;
    else delete state.modelCheckedIds[c.value];
  });
  updateModelsCheckAllLabel();
}
function deleteSelectedModels(){
  var ids = Object.keys(state.modelCheckedIds).map(function(id){return +id;});
  if(!ids.length){ toast('请先勾选模型'); return; }
  confirmDialog('删除所选','确定要删除选中的 <b style="color:#e57373">'+ids.length+'</b> 个模型吗？（当前使用中的会自动跳过）', function(){
    api('/api/models/batch-delete', {method:'POST', body: JSON.stringify({ids:ids})})
      .then(function(res){
        if(res.data.ok){ toast('已删除 '+res.data.deleted+' 个模型'); state.modelCheckedIds = {}; loadModels(); }
        else toast(res.data.msg||'删除失败');
      });
  });
}

// ==================== 检测页当前模型提示 ====================
// 注意：这里被 VIEW_LOADERS['detect'] 注册，go() 与全局 5s 轮询都会调用，
// 因此必须走轻量接口 /api/models/current-name（只查库，不触发模型加载）。
// 不要改回 /api/models —— 它会对 tags 为空的模型触发加载，被 5s 轮询放大后代价很大。
function loadCurrentModelBar(){
  api('/api/models/current-name').then(function(res){
    if(!res.data.ok) return;
    document.getElementById('current-model-name').textContent =
      res.data.name || res.data.file_name || '--';
  });
  checkDetectLock();
}

// ==================== 工作台 ====================
function loadDashStats(){  api('/api/stats').then(function(res){
    if(!res.data.ok) return;
    document.getElementById('stat-records').textContent = res.data.records;
    document.getElementById('stat-today').textContent = res.data.today;
    document.getElementById('stat-online').textContent = res.data.online;
    document.getElementById('stat-model').textContent = res.data.current_model;
    var box = document.getElementById('dash-recent');
    var recs = res.data.recent || [];
    if(!recs.length){
      box.innerHTML = '<div class="record-item" style="color:var(--text-3)">暂无检测记录</div>';
      return;
    }
    box.innerHTML = recs.map(function(r){
      return '<div class="record-item">'+
        '<div class="record-time">'+r.created_at+'</div>'+
        '<div class="record-name">'+(r.image_name||'(视频)')+'</div>'+
        '<div class="record-concl">'+(r.conclusion||'')+'</div></div>';
    }).join('');
  });
}

// ==================== 个人中心 ====================
function loadProfile(){
  api('/api/me').then(function(res){
    if(!res.data.ok) return;
    var u = res.data.user;
    document.getElementById('profile-name').textContent = u.username;
    document.getElementById('profile-role').textContent = u.role==='admin'?'管理员':'普通用户';
    document.getElementById('profile-id').textContent = u.user_code || ('ID: ' + u.id);
    document.getElementById('profile-phone').textContent = u.phone || '—';
    document.getElementById('profile-created').textContent = u.created_at || '—';
    document.getElementById('name-current').value = u.username;
    document.getElementById('phone-current').value = u.phone || '';
    var bk = u.bark_key || '';           // 后端返回的已是掩码串，不再持有明文
    state._barkMasked = bk;              // 仅用于失焦时还原显示
    var bkModal = document.getElementById('bark-modal');
    if(!bkModal || !bkModal.classList.contains('show')){
      var inp = document.getElementById('bark-key-input');
      inp.value = bk;                    // 直接显示掩码串
      inp.dataset.masked = bk ? '1' : '0';
    }
    var bs = document.getElementById('bark-status-text');
    if(bs){ bs.textContent = bk ? ('已配置：' + bk) : '未配置'; bs.style.color = bk ? '#5aa96c' : 'var(--text-3)'; }
  });
}
function openModal(id){
  document.getElementById(id).classList.add('show');
  if(id==='name-modal') loadCaptcha('name');
  if(id==='phone-modal') loadCaptcha('phone');
  if(id==='pw-modal-new') loadCaptcha('pw');
}
function verifyBarkPwd(cb){
  var pwd = document.getElementById('bark-pwd-input').value;
  if(!pwd){ toast('请输入账号密码'); return; }
  api('/api/verify-password', {method:'POST', body: JSON.stringify({password:pwd})})
    .then(function(res){
      if(res.data.ok){ cb(); }
      else { toast(res.data.msg || '密码错误'); }
    });
}
function onBarkKeyFocus(){
  var inp = document.getElementById('bark-key-input');
  if(inp.dataset.masked === '1'){
    inp.value = '';
    inp.dataset.masked = '0';
  }
}
function onBarkKeyBlur(){
  var inp = document.getElementById('bark-key-input');
  if(!inp.value.trim() && state._barkMasked){
    inp.value = state._barkMasked;
    inp.dataset.masked = '1';
  }
}
// 给所有密码框自动加猴子眼睛切换（排除已手动加过的 bark-key-input）
function initPwdEyes(){
  document.querySelectorAll('input[type="password"]').forEach(function(inp){
    if(inp.id === 'bark-key-input') return;
    if(inp.parentElement.classList.contains('pwd-wrap')) return;
    var wrap = document.createElement('div');
    wrap.className = 'pwd-wrap';
    wrap.style.cssText = 'position:relative;';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    inp.style.paddingRight = '40px';
    var eye = document.createElement('span');
    eye.textContent = '👁';
    eye.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-3);font-size:16px;user-select:none;';
    eye.addEventListener('click', function(){
      if(inp.type === 'password'){ inp.type = 'text'; eye.textContent = '🙈'; }
      else { inp.type = 'password'; eye.textContent = '👁'; }
    });
    wrap.appendChild(eye);
  });
}
document.addEventListener('DOMContentLoaded', initPwdEyes);
setTimeout(initPwdEyes, 500);
function getBarkKeyVal(){
  var inp = document.getElementById('bark-key-input');
  return inp.value.trim();   // 掩码串（含 '*'）原样回传，由后端识别为“未变更”
}
var _barkTestBusy = false;
function testBark(){
  if(_barkTestBusy){ return; }   // 防重复点击，避免重复推送
  var btn = document.getElementById('bark-test-btn');
  var key = getBarkKeyVal();
  if(!key){ toast('请先输入 Bark Key 或 URL'); return; }
  verifyBarkPwd(function(){
    var oldText = btn ? btn.textContent : '';
    _barkTestBusy = true;
    if(btn){ btn.disabled = true; btn.textContent = '发送中...'; }
    function restoreBtn(){
      _barkTestBusy = false;
      if(btn){ btn.disabled = false; btn.textContent = oldText || '测试发送'; }
    }
    api('/api/test-bark', {method:'POST', body: JSON.stringify({bark_key:key})})
      .then(function(res){
        if(res.data.ok) toast('测试推送已发送，请查看 iPhone', 'success');
        else toast(res.data.msg || '发送失败');
        restoreBtn();
      }).catch(function(){ toast('网络错误'); restoreBtn(); });
  });
}
function saveBarkKey(){
  var inp = document.getElementById('bark-key-input');
  var key = inp.value.trim();
  verifyBarkPwd(function(){
    api('/api/update-bark', {method:'POST', body: JSON.stringify({bark_key:key})})
      .then(function(res){
        if(res.data.ok){
          toast(key ? 'Bark 推送已开启' : 'Bark 推送已关闭', 'success');
          var bk = res.data.bark_key || '';   // 后端回传的掩码串
          state._barkMasked = bk;
          inp.value = bk;
          inp.dataset.masked = bk ? '1' : '0';
          document.getElementById('bark-pwd-input').value = '';
          var bs = document.getElementById('bark-status-text');
          if(bs){ bs.textContent = bk ? ('已配置：' + bk) : '未配置'; bs.style.color = bk ? '#5aa96c' : 'var(--text-3)'; }
          closeModal('bark-modal');
        } else {
          toast(res.data.msg || '保存失败');
        }
      });
  });
}

// ==================== 用户反馈 ====================
var _fbImages = [];

function loadFeedback(){
  var isAdmin = state.currentUser && state.currentUser.role === 'admin';
  document.getElementById('feedback-user-view').style.display = isAdmin ? 'none' : 'block';
  document.getElementById('feedback-admin-view').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('nav-feedback-title').textContent = isAdmin ? '反馈问题管理' : '问题反馈';
  if(isAdmin){ loadAdminFeedback(); } else { loadMyFeedback(); }
}

function fbImgHtml(urls, size){
  size = size || 60;
  var arr = urls ? urls.split(',').filter(Boolean) : [];
  if(!arr.length) return '';
  return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">' + arr.map(function(u){
    return '<img src="'+u+'" onclick="previewImg(this.src)" style="width:'+size+'px;height:'+size+'px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--line);">';
  }).join('') + '</div>';
}
function fbMsgBubble(m){
  var myRole = (state.currentUser && state.currentUser.role === 'admin') ? 'admin' : 'user';
  var isMe = m.sender === myRole;
  var imgs = m.images ? m.images.split(',').filter(Boolean) : [];
  var imgH = imgs.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;justify-content:'+(isMe?'flex-end':'flex-start')+';">' + imgs.map(function(u){
    return '<img src="'+u+'" onclick="previewImg(this.src)" style="width:70px;height:70px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--line);">';
  }).join('') + '</div>' : '';
  var roleLabel = m.sender === 'admin' ? '管理员' : '用户';
  var label = roleLabel + ' · ' + (m.sender_name || '未知') + (m.sender_code ? '（'+m.sender_code+'）' : '');
  return '<div style="display:flex;justify-content:'+(isMe?'flex-end':'flex-start')+';margin:10px 0;">' +
    '<div style="max-width:80%;padding:10px 14px;border-radius:12px;background:'+(isMe?'var(--accent,#d4a05c)':'var(--card)')+';color:'+(isMe?'#fff':'var(--text-1)')+';">' +
    '<div style="font-size:11px;opacity:.7;margin-bottom:3px;">'+label+' · '+m.created_at+'</div>' +
    (m.content ? '<div style="font-size:13px;line-height:1.6;white-space:pre-wrap;">'+m.content+'</div>' : '') +
    imgH + '</div></div>';
}
function loadMyFeedback(){
  var kw = state.myFbKw || '';
  var cat = state.myFbCat || '';
  var page = state.myFbPage || 1;
  var limit = state.myFbLimit || 20;
  api('/api/feedback/mine?category='+encodeURIComponent(cat)+'&kw='+encodeURIComponent(kw)+'&page='+page+'&limit='+limit).then(function(res){
    if(!res.data.ok) return;
    state.myFeedbacks = res.data.feedbacks || [];
    state.myFbTotal = res.data.total || 0;
    state.myFbPage = res.data.page || 1;
    renderMyFeedback();
    // 用户对话弹窗打开时同步新消息
    var um = document.getElementById('fb-reply-user-modal');
    if(um && um.classList.contains('show') && _fbMsgFid){
      loadFbMessages(_fbMsgFid);
    }
  });
}
function myFbSearch(){
  state.myFbKw = (document.getElementById('fb-my-search')||{value:''}).value.trim();
  state.myFbPage = 1;
  loadMyFeedback();
}
function myFbCatChange(){
  state.myFbCat = (document.getElementById('fb-my-category')||{value:''}).value;
  state.myFbPage = 1;
  loadMyFeedback();
}
function myFbGoPage(p){
  if(p < 1) p = 1;
  state.myFbPage = p;
  loadMyFeedback();
}
function renderMyFeedbackPager(){
  var pager = document.getElementById('my-feedback-pager');
  if(!pager) return;
  var total = state.myFbTotal || 0, page = state.myFbPage || 1, limit = state.myFbLimit || 20;
  var pages = Math.max(1, Math.ceil(total / limit));
  if(total === 0){ pager.innerHTML = '共 0 条'; return; }
  pager.innerHTML =
    '<button class="pg-btn"'+(page<=1?' disabled':'')+' onclick="myFbGoPage('+(page-1)+')">上一页</button>'+
    '<span class="pg-info">第 '+page+' / '+pages+' 页 · 共 '+total+' 条</span>'+
    '<button class="pg-btn"'+(page>=pages?' disabled':'')+' onclick="myFbGoPage('+(page+1)+')">下一页</button>';
}
function renderMyFeedback(){
  var fbs = state.myFeedbacks || [];   // 后端已按 类型+关键字+分页 返回当前页
  var list = document.getElementById('my-feedback-list');
  if(!list) return;
  if(!fbs.length){ list.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:30px;">'+(state.myFbTotal?'没有匹配的反馈':'暂无反馈记录')+'</div>'; return; }
  list.innerHTML = fbs.map(function(f){
    var st = fbStatusBadge(f.status);
    var hasNewReply = f.has_new_reply;
    var newBadge = hasNewReply ? '<span style="margin-left:8px;font-size:11px;background:#e74c3c;color:#fff;padding:2px 8px;border-radius:10px;font-weight:600;">新回复</span>' : '';
    return '<div style="padding:14px;border-bottom:1px solid var(--line);" data-fb-id="'+f.id+'">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<div style="font-weight:600;color:var(--text-1);">'+f.title+newBadge+'</div>' +
      '<span class="fb-status-slot">'+st+'</span></div>' +
      '<div style="font-size:12px;color:var(--text-3);margin-top:4px;">'+fbCategoryText(f.category)+' · '+f.created_at+'</div>' +
      (f.content ? '<div style="font-size:13px;color:var(--text-2);margin-top:6px;white-space:pre-wrap;">'+f.content+'</div>' : '') +
      fbImgHtml(f.images, 60) +
      '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;"><button class="btn btn-ghost" style="font-size:12px;padding:5px 12px;" onclick="openFbUserMsg('+f.id+')">查看对话 / 补充</button>' +
      '<button class="btn btn-ghost" style="font-size:12px;padding:5px 12px;color:#e74c3c;border-color:#e74c3c;" onclick="deleteMyFeedback('+f.id+')">删除</button></div>' +
      '</div>';
  }).join('') + '<div class="pager" id="my-feedback-pager"></div>';
  renderMyFeedbackPager();
}
function fbStatusText(s){
  return {pending:'待处理',processing:'处理中',resolved:'已解决',closed:'已关闭'}[s]||s;
}
function loadFbMessages(fid){
  api('/api/feedback/'+fid+'/messages').then(function(res){
    if(!res.data.ok) return;
    var msgs = res.data.messages || [];
    if(!state._fbMsgLoaded) state._fbMsgLoaded = {};
    var adminBox = document.getElementById('fb-msgs-'+fid);
    var userBox = (_fbMsgFid === fid) ? document.getElementById('fb-msg-timeline') : null;
    [adminBox, userBox].forEach(function(box){
      if(!box) return;
      var key = box.id + '_' + fid;
      var loaded = state._fbMsgLoaded[key] || 0;
      var fresh = msgs.slice(loaded);
      // 记录滚动位置：用户是否在底部附近
      var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      fresh.forEach(function(m){
        var div = document.createElement('div');
        div.innerHTML = fbMsgBubble(m);
        box.appendChild(div.firstChild);
      });
      state._fbMsgLoaded[key] = msgs.length;
      if(nearBottom) box.scrollTop = box.scrollHeight;
    });
  });
}

var _fbMsgFid = 0;
var _fbMsgImages = [];
function openFbUserMsg(fid){
  _fbMsgFid = fid;
  _fbMsgImages = [];
  api('/api/feedback/'+fid+'/read', {method:'POST'});
  document.getElementById('fb-msg-content').value = '';
  document.getElementById('fb-msg-preview').innerHTML = '';
  document.getElementById('fb-msg-notify').checked = false;
  var box = document.getElementById('fb-msg-timeline');
  box.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:20px;font-size:13px;">加载中...</div>';
  openModal('fb-reply-user-modal');
  if(!state._fbMsgLoaded) state._fbMsgLoaded = {};
  state._fbMsgLoaded['fb-msg-timeline_'+fid] = 0;
  api('/api/feedback/'+fid+'/messages').then(function(res){
    if(res.data.ok && res.data.messages && res.data.messages.length){
      box.innerHTML = '';
      loadFbMessages(fid);
    } else {
      box.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:20px;font-size:13px;">暂无对话，在下方输入补充内容</div>';
    }
  });
}
function uploadFbMsgImg(){
  var input = document.getElementById('fb-msg-img');
  if(!input.files.length) return;
  if(_fbMsgImages.length >= 3){ toast('最多 3 张'); input.value=''; return; }
  var f = input.files[0];
  if(f.size > 5*1024*1024){ toast('图片不能超过 5MB'); input.value=''; return; }
  var fd = new FormData();
  fd.append('file', f);
  fetch('/api/feedback/upload', {method:'POST', body:fd, credentials:'same-origin'})
    .then(function(r){return r.json();})
    .then(function(res){
      input.value='';
      if(res.ok){ _fbMsgImages.push(res.url); renderFbMsgPreview(); }
      else toast(res.msg||'上传失败');
    });
}
function renderFbMsgPreview(){
  document.getElementById('fb-msg-preview').innerHTML = _fbMsgImages.map(function(u,i){
    return '<div style="position:relative;display:inline-block;"><img src="'+u+'" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--line);"><span onclick="_fbMsgImages.splice('+i+',1);renderFbMsgPreview();" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:#e74c3c;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;">×</span></div>';
  }).join('');
}
function submitFbUserMsg(){
  var content = document.getElementById('fb-msg-content').value.trim();
  var notify = document.getElementById('fb-msg-notify').checked;
  if(!content && !_fbMsgImages.length){ toast('请输入内容或上传图片'); return; }
  api('/api/feedback/'+_fbMsgFid+'/message', {method:'POST', body: JSON.stringify({content:content, images:_fbMsgImages, notify:notify})})
    .then(function(res){
      if(res.data.ok){
        toast(res.data.msg || '发送成功', 'success');
        document.getElementById('fb-msg-content').value = '';
        _fbMsgImages = [];
        document.getElementById('fb-msg-preview').innerHTML = '';
        loadFbMessages(_fbMsgFid);
        loadMyFeedback();
      } else toast(res.data.msg || '发送失败');
    });
}

function deleteMyFeedback(fid){
  confirmDialog('删除反馈', '确定要删除这条反馈吗？<br><span style="color:#e74c3c;font-size:13px;">将同时删除全部对话记录和已上传的截图，此操作不可恢复。</span>', function(){
    api('/api/feedback/'+fid, {method:'DELETE'}).then(function(res){
      if(res.data.ok){
        toast('反馈已删除', 'success');
        // 立即从数据和 DOM 中移除
        state.myFeedbacks = (state.myFeedbacks||[]).filter(function(f){return f.id!==fid;});
        var card = document.querySelector('[data-fb-id="'+fid+'"]');
        if(card) card.remove();
        // 如果列表空了，显示空状态
        var list = document.getElementById('my-feedback-list');
        if(list && !state.myFeedbacks.length){
          list.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:30px;">暂无反馈记录</div>';
        }
        state._fbRenderedIds = (state._fbRenderedIds||[]).filter(function(id){return id!==fid;});
      } else toast(res.data.msg || '删除失败');
    });
  });
}

function loadAdminFeedback(){
  var st = (document.getElementById('fb-admin-status')||{value:''}).value;
  var kw = (document.getElementById('fb-admin-search')||{value:''}).value.trim();
  var page = state.adminFbPage || 1;
  var limit = state.adminFbLimit || 20;
  api('/api/feedback?status='+encodeURIComponent(st)+'&kw='+encodeURIComponent(kw)+'&page='+page+'&limit='+limit).then(function(res){
    if(!res.data.ok) return;
    state.allFeedbacks = res.data.feedbacks || [];
    state.adminFbTotal = res.data.total || 0;
    state.adminFbPage = res.data.page || 1;
    renderAdminFeedback();
    // 详情弹窗打开时，同步刷新弹窗内消息
    var modal = document.getElementById('fb-detail-modal');
    if(modal && modal.classList.contains('show')){
      var box = modal.querySelector('[id^="fb-msgs-"]');
      if(box){
        var fid = parseInt(box.id.replace('fb-msgs-',''));
        loadFbMessages(fid);
      }
    }
  });
}
function adminFbSearch(){ state.adminFbPage = 1; loadAdminFeedback(); }
function adminFbStatusChange(){ state.adminFbPage = 1; loadAdminFeedback(); }
function adminFbGoPage(p){
  if(p < 1) p = 1;
  state.adminFbPage = p;
  loadAdminFeedback();
}
function renderAdminFeedbackPager(){
  var pager = document.getElementById('fb-pager');
  if(!pager) return;
  var total = state.adminFbTotal || 0, page = state.adminFbPage || 1, limit = state.adminFbLimit || 20;
  var pages = Math.max(1, Math.ceil(total / limit));
  if(total === 0){ pager.innerHTML = '共 0 条'; return; }
  pager.innerHTML =
    '<button class="pg-btn"'+(page<=1?' disabled':'')+' onclick="adminFbGoPage('+(page-1)+')">上一页</button>'+
    '<span class="pg-info">第 '+page+' / '+pages+' 页 · 共 '+total+' 条</span>'+
    '<button class="pg-btn"'+(page>=pages?' disabled':'')+' onclick="adminFbGoPage('+(page+1)+')">下一页</button>';
}
function renderAdminFeedback(){
  var rows = (state.allFeedbacks||[]);   // 后端已按 状态+关键字+分页 返回当前页
  var tbody = document.getElementById('admin-feedback-tbody');
  tbody.innerHTML = rows.map(function(f){
    var hasNewMsg = f.has_new_msg;
    var newTag = hasNewMsg ? '<span style="margin-left:6px;font-size:11px;background:#3498db;color:#fff;padding:2px 8px;border-radius:10px;font-weight:600;">新补充</span>' : '';
    return '<tr data-fid="'+f.id+'">' +
      '<td>'+f.username+newTag+'</td>' +
      '<td style="font-size:13px;color:var(--text-2);">'+(f.user_code||'—')+'</td>' +
      '<td style="font-size:13px;color:var(--text-2);">'+(f.user_phone||'—')+'</td>' +
      '<td>'+fbCategoryText(f.category)+'</td>' +
      '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+f.title+'</td>' +
      '<td class="fb-status-cell">'+fbStatusBadge(f.status)+'</td>' +
      '<td style="font-size:13px;color:var(--text-2);">'+f.created_at+'</td>' +
      '<td><span class="op-link" onclick="openFeedbackDetail('+f.id+')">查看/回复</span></td>' +
      '</tr>';
  }).join('');
  renderAdminFeedbackPager();
}

function openFeedbackDetail(fid){
  var f = (state.allFeedbacks||[]).find(function(x){return x.id===fid});
  if(!f) return;
  api('/api/feedback/'+fid+'/read', {method:'POST'});
  state._fbAdminImages = [];
  var body = '<div style="margin-bottom:10px;">' +
    '<div style="font-size:12px;color:var(--text-3);">提交者：'+f.username+(f.user_code?'（'+f.user_code+'）':'')+' · '+fbCategoryText(f.category)+' · '+f.created_at+'</div>' +
    '<h4 style="font-size:16px;margin:6px 0;color:var(--text-1);">'+f.title+'</h4>' +
    (f.content ? '<div style="font-size:13px;color:var(--text-2);line-height:1.6;white-space:pre-wrap;">'+f.content+'</div>' : '') +
    fbImgHtml(f.images, 70) +
    '<div id="fb-msgs-'+f.id+'" style="max-height:280px;overflow-y:auto;margin-top:6px;"></div>' +
    '</div>' +
    '<div style="border-top:1px solid var(--line);padding-top:12px;">' +
    '<div class="field"><label>回复内容</label><textarea id="fb-reply-text" rows="3" placeholder="输入回复..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text-1);resize:vertical;"></textarea></div>' +
    '<div class="field"><label>回复截图（最多 3 张）</label>' +
    '<div id="fb-admin-img-preview" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;"></div>' +
    '<input type="file" id="fb-admin-img" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none" onchange="uploadFbAdminImg()">' +
    '<button class="btn btn-ghost" type="button" onclick="document.getElementById(\'fb-admin-img\').click()" style="font-size:13px;">+ 添加截图</button></div>' +
    '<div class="field"><label>状态</label>' +
    '<select id="fb-reply-status">' +
    '<option value="pending"'+(f.status==='pending'?' selected':'')+'>待处理</option>' +
    '<option value="processing"'+(f.status==='processing'?' selected':'')+'>处理中</option>' +
    '<option value="resolved"'+(f.status==='resolved'?' selected':'')+'>已解决</option>' +
    '<option value="closed"'+(f.status==='closed'?' selected':'')+'>已关闭</option></select></div>' +
    '<div style="display:flex;align-items:center;gap:8px;margin:8px 0;">' +
    '<input type="checkbox" id="fb-reply-notify" style="width:16px;height:16px;">' +
    '<label for="fb-reply-notify" style="font-size:13px;color:var(--text-2);cursor:pointer;">同时通过 Bark 通知用户</label></div>' +
    '</div>';
  document.getElementById('fb-detail-body').innerHTML = body;
  document.getElementById('fb-detail-foot').innerHTML =
    '<button class="btn btn-ghost" onclick="closeModal(\'fb-detail-modal\')">关闭</button>' +
    '<button class="btn btn-primary" onclick="submitFeedbackReply('+fid+')">发送回复</button>';
  openModal('fb-detail-modal');
  if(!state._fbMsgLoaded) state._fbMsgLoaded = {};
  state._fbMsgLoaded['fb-msgs-'+fid+'_'+fid] = 0;
  loadFbMessages(fid, true);
}
function uploadFbAdminImg(){
  var input = document.getElementById('fb-admin-img');
  if(!input.files.length) return;
  if((state._fbAdminImages||[]).length >= 3){ toast('最多 3 张'); input.value=''; return; }
  var f = input.files[0];
  if(f.size > 5*1024*1024){ toast('图片不能超过 5MB'); input.value=''; return; }
  var fd = new FormData();
  fd.append('file', f);
  fetch('/api/feedback/upload', {method:'POST', body:fd, credentials:'same-origin'})
    .then(function(r){return r.json();})
    .then(function(res){
      input.value='';
      if(res.ok){
        state._fbAdminImages = state._fbAdminImages || [];
        state._fbAdminImages.push(res.url);
        renderFbAdminImgPreview();
      } else toast(res.msg||'上传失败');
    });
}
function renderFbAdminImgPreview(){
  var box = document.getElementById('fb-admin-img-preview');
  if(!box) return;
  box.innerHTML = (state._fbAdminImages||[]).map(function(u,i){
    return '<div style="position:relative;display:inline-block;"><img src="'+u+'" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--line);"><span onclick="state._fbAdminImages.splice('+i+',1);renderFbAdminImgPreview();" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:#e74c3c;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;">×</span></div>';
  }).join('');
}

function submitFeedbackReply(fid){
  var content = document.getElementById('fb-reply-text').value.trim();
  var status = document.getElementById('fb-reply-status').value;
  var notify = document.getElementById('fb-reply-notify').checked;
  var images = state._fbAdminImages || [];
  if(!content && !images.length){ toast('请输入回复内容或上传图片'); return; }
  api('/api/feedback/'+fid+'/message', {method:'POST', body: JSON.stringify({content:content, images:images, notify:notify, status:status})})
    .then(function(res){
      if(res.data.ok){
        toast(res.data.msg || '已发送', 'success');
        document.getElementById('fb-reply-text').value = '';
        state._fbAdminImages = [];
        renderFbAdminImgPreview();
        loadFbMessages(fid);
        loadAdminFeedback();
      } else {
        toast(res.data.msg || '发送失败');
      }
    });
}

function submitFeedback(){
  var cat = document.getElementById('fb-category').value;
  var title = document.getElementById('fb-title').value.trim();
  var content = document.getElementById('fb-content').value.trim();
  var notify = document.getElementById('fb-notify').checked;
  if(!title){ toast('请填写标题'); return; }
  api('/api/feedback', {method:'POST', body: JSON.stringify({category:cat, title:title, content:content, images:_fbImages, notify_admin:notify})})
    .then(function(res){
      if(res.data.ok){
        toast(res.data.msg || '提交成功', 'success');
        document.getElementById('fb-title').value = '';
        document.getElementById('fb-content').value = '';
        document.getElementById('fb-img-preview').innerHTML = '';
        _fbImages = [];
        loadMyFeedback();
      } else {
        toast(res.data.msg || '提交失败');
      }
    });
}

function fbCategoryText(c){
  return {bug:'功能异常', feature:'功能建议', usage:'使用问题', other:'其他'}[c] || c;
}
function fbStatusBadge(s){
  var map = {pending:['待处理','#e8a838'], processing:['处理中','#5b9bd5'], resolved:['已解决','#5aa96c'], closed:['已关闭','#888']};
  var m = map[s] || [s,'#888'];
  return '<span style="font-size:12px;padding:2px 8px;border-radius:4px;background:'+m[1]+'22;color:'+m[1]+';">'+m[0]+'</span>';
}
function previewImg(src){
  openLightbox(src, 'image');
}
function uploadFeedbackImg(){
  var input = document.getElementById('fb-img');
  var files = input.files;
  if(!files.length) return;
  if(_fbImages.length >= 3){ toast('最多上传 3 张图片'); input.value=''; return; }
  var f = files[0];
  if(f.size > 5*1024*1024){ toast('图片不能超过 5MB'); input.value=''; return; }
  var fd = new FormData();
  fd.append('file', f);
  toast('上传中...');
  fetch('/api/feedback/upload', {method:'POST', body:fd, credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(res){
      input.value = '';
      if(res.ok){
        _fbImages.push(res.url);
        toast('上传成功', 'success');
        renderFbImgPreview();
      } else {
        toast(res.msg || '上传失败');
      }
    }).catch(function(){ toast('网络错误'); });
}
function renderFbImgPreview(){
  var box = document.getElementById('fb-img-preview');
  box.innerHTML = _fbImages.map(function(u,i){
    return '<div style="position:relative;display:inline-block;">' +
      '<img src="'+u+'" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--line);">' +
      '<span onclick="_fbImages.splice('+i+',1);renderFbImgPreview();" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:#e74c3c;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;">×</span>' +
      '</div>';
  }).join('');
}
function changeUsername(){
  var nw = document.getElementById('new-username').value.trim();
  var c = document.getElementById('captcha-name').value.trim();
  if(!nw){ toast('请输入新用户名'); return; }
  if(!c){ toast('请输入验证码'); return; }
  api('/api/change-username', {method:'POST', body: JSON.stringify({new_username:nw, captcha_id:_captchaIds.name, captcha_code:c})})
    .then(function(res){
      if(res.data.ok){
        toast('用户名已更新', 'success');
        state.currentUser.username = res.data.username;
        updateChromeUser();
        document.getElementById('profile-name').textContent = res.data.username;
        document.getElementById('name-current').value = res.data.username;
        document.getElementById('new-username').value = '';
        closeModal('name-modal');
      } else {
        toast(res.data.msg || '修改失败');
        loadCaptcha('name');
        document.getElementById('captcha-name').value = '';
      }
    });
}
function changePhone(){
  var np = document.getElementById('new-phone').value.trim();
  var c = document.getElementById('captcha-phone').value.trim();
  if(!/^1\d{10}$/.test(np)){ toast('请输入正确的 11 位手机号'); return; }
  if(!c){ toast('请输入验证码'); return; }
  api('/api/change-phone', {method:'POST', body: JSON.stringify({new_phone:np, captcha_id:_captchaIds.phone, captcha_code:c})})
    .then(function(res){
      if(res.data.ok){
        toast('手机号已更新', 'success');
        document.getElementById('profile-phone').textContent = res.data.phone;
        document.getElementById('phone-current').value = res.data.phone;
        document.getElementById('new-phone').value = '';
        closeModal('phone-modal');
      } else {
        toast(res.data.msg || '修改失败');
        loadCaptcha('phone');
        document.getElementById('captcha-phone').value = '';
      }
    });
}
function changePassword(){
  var old = document.getElementById('pw-old').value;
  var nw = document.getElementById('pw-new').value;
  var nw2 = document.getElementById('pw-new2').value;
  var c = document.getElementById('captcha-pw').value.trim();
  if(!old || !nw){ toast('请填写完整'); return; }
  if(nw !== nw2){ toast('两次新密码不一致'); return; }
  if(!c){ toast('请输入验证码'); return; }
  api('/api/change-password', {method:'POST', body: JSON.stringify({old_password:old, new_password:nw, captcha_id:_captchaIds.pw, captcha_code:c})})
    .then(function(res){
      if(res.data.ok){
        toast('密码已更新，其他设备需重新登录', 'success');
        document.getElementById('pw-old').value='';
        document.getElementById('pw-new').value='';
        document.getElementById('pw-new2').value='';
        document.getElementById('captcha-pw').value='';
        closeModal('pw-modal-new');
      } else {
        toast(res.data.msg||'修改失败');
        loadCaptcha('pw');
        document.getElementById('captcha-pw').value='';
      }
    });
}

// ==================== 新增用户 ====================
function openUserModal(){
  document.getElementById('nu-phone').value='';
  document.getElementById('nu-username').value='';
  document.getElementById('nu-password').value='';
  document.getElementById('nu-role').value='user';
  document.getElementById('user-modal').classList.add('show');
}
function submitNewUser(){
  var phone = document.getElementById('nu-phone').value.trim();
  var username = document.getElementById('nu-username').value.trim();
  var password = document.getElementById('nu-password').value;
  var role = document.getElementById('nu-role').value;
  if(!phone || !/^1\d{10}$/.test(phone)){ toast('请输入正确的 11 位手机号'); return; }
  if(!password){ toast('请填写密码'); return; }
  api('/api/users', {method:'POST', body: JSON.stringify({phone:phone, username:username, password:password, role:role})})
    .then(function(res){
      if(res.data.ok){ closeModal('user-modal'); toast('用户已创建'); loadUsers(); }
      else toast(res.data.msg||'创建失败');
    });
}

// ==================== 新增/编辑文章 ====================
var editingArticleId = null;
function openArticleModal(aid){
  editingArticleId = aid || null;
  var a = aid ? (state.articles||[]).find(function(x){return x.id===aid;}) : null;
  document.getElementById('aa-title').value = a ? a.title : '';
  document.getElementById('aa-summary').value = a ? (a.summary||'') : '';
  document.getElementById('aa-content').value = a ? (a.content||'') : '';
  document.getElementById('aa-category').value = a ? (a.category||'综合') : '综合';
  document.getElementById('aa-status').value = a ? (a.status||'published') : 'published';
  document.getElementById('article-modal-title').textContent = a ? '编辑文章' : '新增文章';
  document.getElementById('article-modal').classList.add('show');
}
function submitArticle(){
  var title = document.getElementById('aa-title').value.trim();
  if(!title){ toast('标题不能为空'); return; }
  var body = {
    title: title,
    summary: document.getElementById('aa-summary').value,
    content: document.getElementById('aa-content').value,
    category: document.getElementById('aa-category').value,
    status: document.getElementById('aa-status').value
  };
  var url = editingArticleId ? '/api/articles/'+editingArticleId : '/api/articles';
  var method = editingArticleId ? 'PUT' : 'POST';
  api(url, {method: method, body: JSON.stringify(body)})
    .then(function(res){
      if(res.data.ok){ closeModal('article-modal'); toast(editingArticleId?'已更新':'已发布'); loadArticles(); }
      else toast(res.data.msg||'保存失败');
    });
}

// 页面关闭/切后台/切标签时，立即通知后端下线
function _notifyOffline(){
  if(!state.currentUser) return;
  try { navigator.sendBeacon(API + '/api/offline'); } catch(e){}
}
window.addEventListener('pagehide', _notifyOffline);
document.addEventListener('visibilitychange', function(){
  if(document.visibilityState === 'hidden'){
    _notifyOffline();
  }
});

// ==================== 多端实时同步（轻量轮询） ====================
var _lastMeSig = '';
var _syncTimer = setInterval(function(){
  if(!state.currentUser) return;
  // 页面不可见时不轮询（切后台/切标签即视为离线）
  if(document.visibilityState !== 'visible') return;
  // 1) 验证登录态（被踢/改密码/拉黑）
  api('/api/me').then(function(res){
    if(res.status === 401 || !res.data.ok){
      // 登录态失效（api() 辅助已弹 toast，这里只做跳转兜底）
      state.currentUser = null;
      go('login');
      return;
    }
    // 2) 角色/用户信息变化时刷新 chrome
    var sig = JSON.stringify(res.data.user);
    if(sig !== _lastMeSig){
      _lastMeSig = sig;
      state.currentUser = res.data.user;
      updateChromeUser();
    }
    // 3) 当前页数据同步刷新（统一走 VIEW_LOADERS 注册表，新增视图无需再改这里）
    loadCurrentView();
  }).catch(function(){});
}, 5000);

// ==================== 全局快捷键 ====================
document.addEventListener('keydown', function(e){
  if(e.key !== 'Enter' || e.ctrlKey || e.altKey || e.shiftKey) return;
  // 焦点在 textarea 时回车用于换行，不触发保存（用户可 Ctrl+Enter 提交）
  var tag0 = (e.target.tagName || '').toLowerCase();
  if(tag0 === 'textarea' && !e.ctrlKey && !e.shiftKey) return;
  // 任何打开的弹窗：回车触发主操作按钮
  var openModalEl = document.querySelector('.modal-mask.show');
  if(openModalEl){
    var primary = openModalEl.querySelector('#confirm-ok, .modal-foot .btn-primary, .modal-foot .btn-orange, .modal-body .btn-primary');
    if(primary && !primary.disabled){ primary.click(); e.preventDefault(); }
    return;
  }
  var tag = (e.target.tagName || '').toLowerCase();
  var inInput = (tag === 'input' || tag === 'textarea' || tag === 'select');
  if(!inInput) return;
  // 登录页：回车登录
  if(document.getElementById('view-login').classList.contains('active')){
    var codeMode = document.getElementById('login-code-mode');
    if(codeMode && codeMode.style.display !== 'none'){
      doLoginWithCode();
    } else {
      doLogin();
    }
    e.preventDefault();
  }
  // 注册页：回车注册
  else if(document.getElementById('view-register').classList.contains('active')){
    doRegister(); e.preventDefault();
  }
});

// ==================== 图片/视频 放大预览 Lightbox ====================
// boxData（可选）：
//   图片：{boxes, iw, ih} —— 原图空间坐标（来自结果图 canvas 的 _boxData），放大后按新尺寸重画框
//   视频：{boxes(帧时间轴), fps, w, h, names} —— 来自 video 元素的 _boxTimeline，放大后照常逐帧画框
var _lbVideoRAF = null;
var _lbBoxState = null;

// ==================== 视频"放大/全屏"：与历史详情页一致 ====================
// 最终形态（2026-10-22 深夜定稿，三轮实测得出，结论写死在这）：
//   检测页结果视频 / 详情页视频统统**不带原生控件**（muted + 自动循环播放），
//   **点画面 → 打开放大层**，放大层里有原生播放控件、原声、检测框 —— 这就是"点视频就放大"。
// ⚠ 绝不要给结果视频加原生 controls：
//   ① 原生全屏按钮只全屏 <video> 本身，叠加画框的 canvas 是它的兄弟节点 → 全屏里没框；
//   ② "video 入栈后再压容器"（Chrome 全屏是元素栈）时成时不成 —— 失败时用户看到
//      "能进全屏却没框"，比没按钮更糟；成功时还会留下两层栈（Esc 要按两次）。
// 真全屏（需要时）：放大层里**双击画面** → 对含 canvas 的容器请求全屏，手势内必成功、有框。
// 下方压栈逻辑仅作兜底：万一某浏览器仍出现 video 全屏，尽量把它换成容器。
var _fsStacked = false;      // 本次全屏是否已经在 video 之上压了一层容器
var _fsHijacking = false;

function _fsWrapOf(el){
  return el.closest('#video-result, .img-frame, #lightbox-vidwrap') || el.parentElement;
}

// （⛶ 按钮方案已按用户要求移除：点画面进放大层即可，需要真全屏时在放大层双击画面）

// 放大层里的视频：**双击画面 = 真全屏**（对容器请求，检测框照样在）。
// 不用按钮是为了不占画面（⛶ 已按用户要求移除）；双击在用户手势内 → requestFullscreen 必成功。
document.addEventListener('dblclick', function(e){
  var t = e.target;
  if(!t || t.tagName !== 'VIDEO' || !t.closest('#lightbox-vidwrap')) return;
  var wrap = document.getElementById('lightbox-vidwrap');
  if(!wrap) return;
  if(document.fullscreenElement === wrap){ document.exitFullscreen(); return; }
  if(wrap.requestFullscreen){ wrap.requestFullscreen().catch(function(){}); }
});

document.addEventListener('fullscreenchange', function(){
  var fs = document.fullscreenElement;
  if(!fs){
    _fsStacked = false;
    // 退出全屏：放大层的视频还在后台播（有原声），用户会以为"没释放"→ 直接停掉。
    // 延迟一拍再判：全屏切换的瞬间也会出现一次 null，别误伤
    setTimeout(function(){
      if(_fsHijacking || document.fullscreenElement) return;
      var lb = document.getElementById('lightbox');
      if(!lb || lb.style.display !== 'flex') return;
      var v = document.getElementById('lightbox-video');
      if(v && !v.paused){ v.pause(); }
    }, 250);
    return;
  }
  if(fs.tagName !== 'VIDEO') return;      // 容器全屏 = 目标状态（有框），不用管
  // Esc 弹栈露出了底下那层 video 全屏（无框、带原生控件）→ 再退一层，直接回到页面
  if(_fsStacked){
    try { document.exitFullscreen(); } catch(e){}
    return;
  }
  // 用户刚点了原生全屏按钮：video 入栈 → 把含 canvas 的容器压上去，得到带框全屏
  var wrap = _fsWrapOf(fs);
  if(!wrap || wrap === fs) return;
  _fsHijacking = true;
  _fsStacked = true;
  try {
    var p = wrap.requestFullscreen();
    var done = function(){ _fsHijacking = false; };
    if(p && p.then){ p.then(done).catch(done); } else { done(); }
  } catch(e){ _fsHijacking = false; }
});

function openLightbox(src, type, boxData){
  var lb = document.getElementById('lightbox');
  var img = document.getElementById('lightbox-img');
  var vid = document.getElementById('lightbox-video');
  var imgwrap = document.getElementById('lightbox-imgwrap');
  var vidwrap = document.getElementById('lightbox-vidwrap');
  var imgCv = document.getElementById('lightbox-img-canvas');
  var vidCv = document.getElementById('lightbox-video-canvas');
  var hasBoxes = boxData && boxData.boxes && boxData.boxes.length;
  _lbBoxState = boxData || null;
  if(type === 'video'){
    imgwrap.style.display = 'none'; img.style.display = 'none';
    vidwrap.style.display = 'block'; vid.style.display = 'block';
    vidCv.style.display = hasBoxes ? 'block' : 'none';
    var g = vidCv.getContext('2d'); g.clearRect(0, 0, vidCv.width, vidCv.height);
    vid.src = src;
    vid.play().catch(function(){});
    startLbVideoBoxes();
  } else {
    stopLbVideoBoxes();
    vid.pause(); vid.removeAttribute('src'); vid.load();
    vidwrap.style.display = 'none'; vid.style.display = 'none';
    imgwrap.style.display = 'block'; img.style.display = 'block';
    imgCv.style.display = hasBoxes ? 'block' : 'none';
    var gi = imgCv.getContext('2d'); gi.clearRect(0, 0, imgCv.width, imgCv.height);
    img.onload = function(){ drawLbImgBoxes(); };
    img.src = src;
    if(img.complete && img.naturalWidth){ drawLbImgBoxes(); }
  }
  lb.style.display = 'flex';
}
function closeLightbox(){
  stopLbVideoBoxes();
  // 彻底释放：只 pause 的话解码/缓冲还在后台跑（声音也还在）；清掉 src 才真正停
  var vid = document.getElementById('lightbox-video');
  if(vid){
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
  }
  document.getElementById('lightbox').style.display = 'none';
  if(document.fullscreenElement) document.exitFullscreen();
}
// Lightbox 图片：按显示尺寸重画框（框线/字号跟随放大，不是拉伸旧像素）
function drawLbImgBoxes(){
  var img = document.getElementById('lightbox-img');
  var cv = document.getElementById('lightbox-img-canvas');
  var bd = _lbBoxState;
  if(!img || !cv) return;
  var bw = img.clientWidth, bh = img.clientHeight;
  if(!bw || !bh || !bd || !bd.boxes || !bd.boxes.length || !bd.iw || !bd.ih) return;
  var sc = bw / bd.iw;
  var dpr = window.devicePixelRatio || 1;
  var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
  if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, bw, bh);
  drawBoxesCore(g, bd.boxes, sc, 2, 12, 1);
}
// Lightbox 视频：复用结果视频的逐帧画框逻辑（时间轴 + object-fit:contain 留白换算）
function lbVideoLoop(){
  var lb = document.getElementById('lightbox');
  if(!lb || lb.style.display === 'none'){ _lbVideoRAF = null; return; }
  var v = document.getElementById('lightbox-video');
  var cv = document.getElementById('lightbox-video-canvas');
  var bd = _lbBoxState;
  if(v && cv && bd && bd.boxes && bd.boxes.length && v.duration){
    var bw = v.clientWidth, bh = v.clientHeight;
    if(bw && bh){
      var fw = bd.w || v.videoWidth, fh = bd.h || v.videoHeight;
      if(fw && fh){
        var sc = Math.min(bw / fw, bh / fh);
        var ox = (bw - fw * sc) / 2, oy = (bh - fh * sc) / 2;
        var dpr = window.devicePixelRatio || 1;
        var cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
        if(cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
        var g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, bw, bh);
        var idx = Math.round((v.currentTime || 0) * (bd.fps || 25));
        if(idx < 0) idx = 0;
        if(idx >= bd.boxes.length) idx = bd.boxes.length - 1;
        var arr = bd.boxes[idx] || [];
        if(arr.length){
          var boxes = arr.map(function(a){
            return {cls: a[0], cls_name: bd.names[String(a[0])] || String(a[0]),
                    conf: a[1], x1: a[2], y1: a[3], x2: a[4], y2: a[5]};
          });
          drawBoxesCore(g, boxes, sc, 2, 12, 1, ox, oy);
        }
      }
    }
  }
  _lbVideoRAF = requestAnimationFrame(lbVideoLoop);
}
function startLbVideoBoxes(){
  if(!_lbVideoRAF) _lbVideoRAF = requestAnimationFrame(lbVideoLoop);
}
function stopLbVideoBoxes(){
  if(_lbVideoRAF){ cancelAnimationFrame(_lbVideoRAF); _lbVideoRAF = null; }
  var cv = document.getElementById('lightbox-video-canvas');
  if(cv){ var g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); }
}
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') closeLightbox();
});
// 给结果图/视频统一绑定点击放大（事件委托）
// 页面关闭/刷新时释放工控页锁
window.addEventListener('beforeunload', function(){
  if(typeof indReleasePageLock === 'function') indReleasePageLock();
});

document.addEventListener('click', function(e){
  var t = e.target;
  if(t.tagName === 'IMG' && t.dataset.zoomable !== 'false'){
    // 只放大有 data-zoom 标记的图，或在 .img-frame / result-imgs 里的图
    if(t.closest('.img-frame, .result-imgs, #lightbox')){
      if(t.closest('#lightbox')) return;
      // 结果图的框画在相邻 canvas 上：带上它的 _boxData，Lightbox 里按新尺寸重画
      var cv = t.parentElement ? t.parentElement.querySelector('canvas') : null;
      openLightbox(t.src, 'image', cv ? cv._boxData : null);
    }
  }
  if(t.tagName === 'VIDEO' && t.dataset.zoomable !== 'false'){
    // 详情页两个视频本身不带控件（自动循环播放），点画面即放大到 Lightbox（那里才有播放控件）
    if(t.closest('#video-result, .result-video') ||
       t.id === 'detail-result-video' || t.id === 'detail-orig-video'){
      if(t.closest('#lightbox')) return;
      // 结果视频的时间轴挂在 video 元素上（_boxTimeline），Lightbox 里照常逐帧画框
      openLightbox(t.src, 'video', t._boxTimeline || null);
    }
  }
});

// ==================== 模型训练 ====================
var trainJobs = [];
var trainMetaLoaded = false;
var trainEdit = false;
var trainChecked = {};
var trainStopTarget = null;
var trainExportTarget = null;
var trainDatasets = [];
var trainHasRunning = false;

var TRAIN_STATUS = {
  running:     {text:'训练中', cls:'st-running'},
  done:        {text:'已完成', cls:'st-done'},
  paused:      {text:'已暂停', cls:'st-paused'},
  failed:      {text:'失败',   cls:'st-failed'},
  interrupted: {text:'已中断', cls:'st-interrupted'},
  unregistered:{text:'未登记', cls:'st-interrupted'}
};

var TRAIN_EXPORT_FORMATS = [
  {fmt:'onnx',        name:'ONNX',        desc:'通用跨平台部署格式（推荐）'},
  {fmt:'torchscript', name:'TorchScript', desc:'PyTorch 原生部署格式'},
  {fmt:'tflite',      name:'TFLite',      desc:'移动端 / 边缘设备（Windows 不支持，需 Linux/macOS）'},
  {fmt:'tensorrt',    name:'TensorRT',    desc:'NVIDIA GPU 加速推理（需 tensorrt）'},
  {fmt:'openvino',    name:'OpenVINO',    desc:'Intel CPU / GPU 加速（需 openvino）'},
  {fmt:'coreml',      name:'CoreML',      desc:'Apple 设备部署（需 coremltools）'},
  {fmt:'paddle',      name:'PaddlePaddle',desc:'百度飞桨格式（需 paddle2onnx）'}
];

function fmtDuration(sec){
  if(sec==null||isNaN(sec)) return '-';
  sec = Math.max(0, Math.floor(sec));
  var d=Math.floor(sec/86400), h=Math.floor(sec%86400/3600), m=Math.floor(sec%3600/60), s2=sec%60;
  if(d>0) return d+'天'+h+'时'+m+'分'+s2+'秒';
  if(h>0) return h+'时'+m+'分'+s2+'秒';
  if(m>0) return m+'分'+s2+'秒';
  return s2+'秒';
}
function fmtEta(sec){
  if(sec==null||isNaN(sec)) return '计算中…';
  return fmtDuration(sec);
}
function fmtSize(bytes){
  if(!bytes) return '-';
  if(bytes>1024*1024*1024) return (bytes/1024/1024/1024).toFixed(2)+' GB';
  if(bytes>1024*1024) return (bytes/1024/1024).toFixed(1)+' MB';
  return (bytes/1024).toFixed(0)+' KB';
}

function loadTrain(){
  if(!trainMetaLoaded){ initTrainMeta(); trainMetaLoaded=true; }
  loadTrainJobs();
}

function initTrainMeta(){
  api('/api/train/device').then(function(res){
    var bar=document.getElementById('train-device-bar');
    if(!bar) return;
    var d=res.data&&res.data.device;
    if(d&&d.cuda){
      bar.className='train-device-bar ok';
      bar.textContent='服务器检测到 GPU：'+d.name+'（'+d.vram_gb+' GB 显存），将使用 GPU 训练';
    }else{
      bar.className='train-device-bar warn';
      bar.textContent='服务器未检测到 CUDA，将使用 CPU 训练，速度会非常慢，建议减少 epochs';
    }
  }).catch(function(){});
  api('/api/train/datasets').then(function(res){
    state.datasetsDir=(res.data&&res.data.datasets_dir)||'';
    updateDirButton();
    trainDatasets=(res.data&&res.data.datasets)||[];
    var sel=document.getElementById('tf-dataset');
    if(!sel) return;
    sel.innerHTML='<option value="" disabled selected>请选择数据集</option>'+
      trainDatasets.map(function(d){
        return '<option value="'+d.name+'">'+d.name+' · '+d.train_count+'/'+d.val_count+' · '+d.num_classes+'类（'+d.classes.join('/')+'）</option>';
      }).join('') || '<option value="">未发现数据集</option>';
  });
  api('/api/train/backbones').then(function(res){
    state.backbonesDir=(res.data&&res.data.backbones_dir)||'';
    updateBackboneDirButton();
    var list=(res.data&&res.data.backbones)||[];
    var sel=document.getElementById('tf-backbone');
    if(!sel) return;
    sel.innerHTML='<option value="" disabled selected>请选择基础模型</option>'+
      (list.length
        ? list.map(function(b){
            return '<option value="'+b.file+'">'+b.file+'（'+fmtSize(b.size_bytes)+'）</option>';
          }).join('')
        : '<option value="" disabled>未发现基础模型，请点右侧「更新」下载</option>');
    // 恢复用户上次选择的基础模型
    var last = localStorage.getItem('train_last_backbone');
    if(last && list.some(function(b){return b.file===last;})){
      sel.value = last;
    }
  });
}
function onTrainBackboneChange(){
  var v = document.getElementById('tf-backbone').value;
  if(v) localStorage.setItem('train_last_backbone', v);
}

// ===== 基础模型「更新」：从 ultralytics 官方拉取最新预训练权重 =====
// 权重清单弹窗：全选 / 取消全选 —— 同一个按钮来回切换
function bbAllChecked(){
  var cbs = document.querySelectorAll('.bb-fetch');
  if(!cbs.length) return false;
  var all = true;
  cbs.forEach(function(cb){ if(!cb.checked) all = false; });
  return all;
}
function bbToggleAll(){
  var cbs = document.querySelectorAll('.bb-fetch');
  if(!cbs.length) return;
  var target = !bbAllChecked();      // 当前已全选 -> 取消；否则 -> 全选
  cbs.forEach(function(cb){ cb.checked = target; });
  bbUpdateToggleAllText();
}
function bbUpdateToggleAllText(){
  var btn = document.getElementById('bb-toggle-all-btn');
  if(btn) btn.textContent = bbAllChecked() ? '取消全选' : '全选';
}

function openBackboneFetchDialog(){
  showLoading('正在查询官方最新版本...', 10);
  fetch('/api/train/backbones/latest').then(function(r){ return r.json(); }).then(function(res){
    hideLoading();
    if(!res.ok){ toast(res.msg || '查询失败', 'error'); return; }
    var items = res.items || [];
    if(!items.length){ toast('官方最新版本里没有匹配的权重'); return; }
    // 默认勾选：本地还没有的；全都有的话就允许覆盖更新（默认全不选，避免误覆盖）
    var hasMissing = items.some(function(i){ return !i.exists; });
    var rows = items.map(function(i){
      var mb = (i.size / 1024 / 1024).toFixed(1) + ' MB';
      return '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer">' +
        '<input type="checkbox" class="bb-fetch" value="' + i.name + '"' +
        ((!i.exists && hasMissing) ? ' checked' : '') +
        ' onchange="bbUpdateToggleAllText()">' +
        '<span style="flex:1;font-family:monospace;font-size:12px">' + i.name + '</span>' +
        '<span style="font-size:11px;color:var(--text-3)">' + mb +
        (i.exists ? ' · 已存在' : '') + '</span></label>';
    }).join('');
    confirmDialog('拉取官方预训练权重（' + (res.tag || '最新版') + ' · ' + res.series + '）',
      '<div style="text-align:left;font-size:13px;line-height:1.7">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '  <span style="flex:1">勾选要下载到 <b>pretrained_models</b> 的权重：</span>' +
      '  <button type="button" id="bb-toggle-all-btn" class="btn btn-ghost btn-sm"' +
      '    style="padding:2px 8px;font-size:12px" onclick="bbToggleAll()">全选</button>' +
      '</div>' +
      '<div style="max-height:220px;overflow:auto">' + rows + '</div>' +
      '<p style="margin:6px 0 0;color:var(--text-3);font-size:12px">' +
      '来源：ultralytics/assets GitHub Release。下载在后台进行，不阻塞页面。' +
      (hasMissing ? '' : '（本地已齐全，如需覆盖更新请手动勾选）') + '</p>' +
      '</div>',
      function(){
        var names = [];
        document.querySelectorAll('.bb-fetch').forEach(function(cb){
          if(cb.checked) names.push(cb.value);
        });
        if(!names.length){ toast('没有勾选任何权重'); return; }
        fetch('/api/train/backbones/fetch', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({names: names})
        }).then(function(r){ return r.json(); }).then(function(res2){
          if(!res2.ok){ toast(res2.msg || '启动下载失败', 'error'); return; }
          showLoading('开始下载...', 5);
          var timer = setInterval(function(){
            fetch('/api/train/backbones/fetch-status').then(function(r){ return r.json(); })
              .then(function(r3){
                var s = (r3.status) || {};
                showLoading('正在下载 ' + s.done + '/' + s.total +
                            (s.current ? '：' + s.current : ''), 10);
                if(s.finished && !s.running){
                  clearInterval(timer);
                  hideLoading();
                  var errN = (s.errors || []).length;
                  if(errN){
                    toast('完成 ' + s.done + ' 个，失败 ' + errN + ' 个：' +
                          (s.errors[0].msg || ''), 'error');
                  } else {
                    toast('已拉取 ' + s.done + ' 个权重');
                  }
                  initTrainMeta();   // 刷新基础模型下拉
                }
              }).catch(function(){});
          }, 1000);
        }).catch(function(){ hideLoading(); toast('请求失败', 'error'); });
      });
    // 弹窗渲染完立即同步按钮文字（默认勾选可能已是全选状态）
    bbUpdateToggleAllText();
  }).catch(function(){ hideLoading(); toast('查询失败', 'error'); });
}

function onTrainDatasetChange(){
  // 选中未划分的数据集时提前提示，避免用户配了一堆参数才发现不能训
  var name = (document.getElementById('tf-dataset') || {}).value;
  if(!name) return;
  var ds = (trainDatasets || []).find(function(d){ return d.name === name; });
  if(ds && (!ds.train_count || !ds.val_count)){
    toast('该数据集尚未划分（当前 ' + (ds.train_count||0) + '/' + (ds.val_count||0) +
          '），请点旁边的「自动划分」', 'error');
  }
}

// ===== 数据集自动划分（训练页）=====
// 把 images/ + labels/ 平铺的原始数据集自动切成 train/val 结构
function openDatasetSplitDialog(){
  var sel = document.getElementById('tf-dataset');
  var name = sel ? sel.value : '';
  if(!name){ toast('请先在数据集下拉框中选择要划分的数据集'); return; }
  var ds = (trainDatasets || []).find(function(d){ return d.name === name; });
  if(ds && ds.train_count > 0){
    toast('数据集「' + name + '」已划分过（train ' + ds.train_count + ' 张），无需再划分');
    return;
  }
  confirmDialog('自动划分数据集',
    '<div style="text-align:left;font-size:13px;line-height:1.8">' +
    '<p style="margin:0 0 8px">对数据集 <b>' + name + '</b> 执行自动划分：</p>' +
    '<div style="display:flex;gap:10px;margin-bottom:8px">' +
    '  <label style="flex:1">验证集占比 ' +
    '    <select id="ds-split-ratio" class="input" style="width:100%">' +
    '      <option value="0.1">10%</option><option value="0.15">15%</option>' +
    '      <option value="0.2" selected>20%</option><option value="0.3">30%</option>' +
    '    </select></label>' +
    '  <label style="flex:1">处理方式 ' +
    '    <select id="ds-split-mode" class="input" style="width:100%">' +
    '      <option value="copy" selected>复制（保留原文件）</option>' +
    '      <option value="move">移动（节省空间）</option>' +
    '    </select></label>' +
    '</div>' +
    '<p style="margin:0;color:var(--text-3);font-size:12px">图片与标注随机打乱后按比例切分；' +
    '没有标注的图片会作为背景样本一并纳入；完成后自动生成 data.yaml。</p>' +
    '</div>',
    function(){
      // 确认时弹窗 DOM 仍在，可直接读取表单值
      var ratio = parseFloat((document.getElementById('ds-split-ratio') || {}).value || '0.2');
      var mode = (document.getElementById('ds-split-mode') || {}).value || 'copy';
      showLoading('正在划分「' + name + '」...', 15);
      fetch('/api/train/datasets/split', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name, val_ratio: ratio, mode: mode})
      }).then(function(r){ return r.json(); }).then(function(res){
        hideLoading();
        if(!res.ok){ toast(res.msg || '划分失败', 'error'); return; }
        var st = res.stats || {};
        toast('划分完成：训练 ' + st.train + ' 张 / 验证 ' + st.val + ' 张' +
              (st.without_label ? ('（含无标注背景样本 ' + st.without_label + ' 张）') : ''));
        loadTrain();   // 刷新数据集下拉，出现新的 train/val 数量
      }).catch(function(){ hideLoading(); toast('请求失败', 'error'); });
    });
}

function trainOpenDir(){
  var path=state.datasetsDir||'（未能从后端取到数据集目录，请刷新页面重试）';
  confirmDialog('数据集文件夹说明',
    '<div style="text-align:left;line-height:1.7;font-size:13.5px">'+
    '<p style="margin:0 0 8px"><b>文件夹位置：</b>'+path+'</p>'+
    '<p style="margin:0 0 8px"><b>作用：</b>该目录是训练数据集的统一存放位置，每个子文件夹对应一个独立的训练数据集。</p>'+
    '<p style="margin:0 0 8px"><b>打开后可以做什么：</b></p>'+
    '<ul style="margin:0 0 8px;padding-left:20px">'+
    '<li>放入新的数据集文件夹（需按 images/labels 结构组织，包含 train/val 划分）</li>'+
    '<li>查看现有数据集的图片数量、类别和标注情况</li>'+
    '<li>手动整理、重命名或删除不需要的数据集</li>'+
    '</ul>'+
    '<p style="margin:0;color:var(--text-3);font-size:12.5px">点击「确认」后将在本机文件管理器中打开该文件夹。</p>'+
    '</div>',
    function(){
      api('/api/train/open-dir',{method:'POST'}).then(function(res){
        toast(res.data&&res.data.ok?'已打开数据集文件夹':'打开失败', res.data&&res.data.ok?'success':'error');
      });
    });
}
function isLocalAccess(){
  var h=location.hostname;
  return h==='127.0.0.1'||h==='localhost'||h==='::1';
}
function updateDirButton(){
  var local=isLocalAccess();
  var bl=document.getElementById('train-dir-btn-local');
  var br=document.getElementById('train-dir-btn-remote');
  if(bl) bl.style.display=local?'':'none';
  if(br) br.style.display=local?'none':'';
}
function copyText(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text);
  }else{
    var ta=document.createElement('textarea');
    ta.value=text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }
}
function copyDatasetsDir(){
  var path=state.datasetsDir||'（未能从后端取到数据集目录，请刷新页面重试）';
  confirmDialog('数据集文件夹说明',
    '<div style="text-align:left;line-height:1.7;font-size:13.5px">'+
    '<p style="margin:0 0 8px"><b>文件夹位置：</b>'+path+'</p>'+
    '<p style="margin:0 0 8px"><b>作用：</b>该目录是训练数据集的统一存放位置，每个子文件夹对应一个独立的训练数据集。</p>'+
    '<p style="margin:0 0 8px"><b>打开后可以做什么：</b></p>'+
    '<ul style="margin:0 0 8px;padding-left:20px">'+
    '<li>放入新的数据集文件夹（需按 images/labels 结构组织，包含 train/val 划分）</li>'+
    '<li>查看现有数据集的图片数量、类别和标注情况</li>'+
    '<li>手动整理、重命名或删除不需要的数据集</li>'+
    '</ul>'+
    '<p style="margin:0;color:var(--text-3);font-size:12.5px">当前为局域网远程访问，无法直接在你的设备上打开服务器文件夹。点击「确认」后路径将复制到剪贴板，请到服务器电脑上粘贴打开。</p>'+
    '</div>',
    function(){
      copyText(path);
      toast('数据集路径已复制','success');
    });
}
function updateBackboneDirButton(){
  var local=isLocalAccess();
  var bl=document.getElementById('train-bb-btn-local');
  var br=document.getElementById('train-bb-btn-remote');
  if(bl) bl.style.display=local?'':'none';
  if(br) br.style.display=local?'none':'';
}
function trainOpenBackboneDir(){
  var path=state.backbonesDir||'（未能从后端取到预训练权重目录，请刷新页面重试）';
  confirmDialog('预训练权重文件夹说明',
    '<div style="text-align:left;line-height:1.7;font-size:13.5px">'+
    '<p style="margin:0 0 8px"><b>文件夹位置：</b>'+path+'</p>'+
    '<p style="margin:0 0 8px"><b>作用：</b>该目录存放官方预训练权重文件（.pt 格式），训练时作为基础模型（起点）加载。</p>'+
    '<p style="margin:0 0 8px"><b>打开后可以做什么：</b></p>'+
    '<ul style="margin:0 0 8px;padding-left:20px">'+
    '<li>放入新的预训练权重文件（.pt 格式），刷新页面后会自动出现在「基础模型」下拉列表中</li>'+
    '<li>查看现有预训练权重的文件名和大小</li>'+
    '<li>删除不需要的预训练权重文件</li>'+
    '</ul>'+
    '<p style="margin:0;color:var(--text-3);font-size:12.5px">点击「确认」后将在本机文件管理器中打开该文件夹。</p>'+
    '</div>',
    function(){
      api('/api/train/open-backbone-dir',{method:'POST'}).then(function(res){
        toast(res.data&&res.data.ok?'已打开预训练权重文件夹':'打开失败', res.data&&res.data.ok?'success':'error');
      });
    });
}
function copyBackbonesDir(){
  var path=state.backbonesDir||'（未能从后端取到预训练权重目录，请刷新页面重试）';
  confirmDialog('预训练权重文件夹说明',
    '<div style="text-align:left;line-height:1.7;font-size:13.5px">'+
    '<p style="margin:0 0 8px"><b>文件夹位置：</b>'+path+'</p>'+
    '<p style="margin:0 0 8px"><b>作用：</b>该目录存放官方预训练权重文件（.pt 格式），训练时作为基础模型（起点）加载。</p>'+
    '<p style="margin:0 0 8px"><b>打开后可以做什么：</b></p>'+
    '<ul style="margin:0 0 8px;padding-left:20px">'+
    '<li>放入新的预训练权重文件（.pt 格式），刷新页面后会自动出现在「基础模型」下拉列表中</li>'+
    '<li>查看现有预训练权重的文件名和大小</li>'+
    '<li>删除不需要的预训练权重文件</li>'+
    '</ul>'+
    '<p style="margin:0;color:var(--text-3);font-size:12.5px">当前为局域网远程访问，无法直接在你的设备上打开服务器文件夹。点击「确认」后路径将复制到剪贴板，请到服务器电脑上粘贴打开。</p>'+
    '</div>',
    function(){
      copyText(path);
      toast('预训练权重路径已复制','success');
    });
}
function resetTrainForm(){
  // 基础字段
  document.getElementById('tf-backbone').value = '';
  document.getElementById('tf-dataset').value = '';
  document.getElementById('tf-name').value = '';
  document.getElementById('tf-epochs').value = 100;
  document.getElementById('tf-batch').value = 16;
  document.getElementById('tf-imgsz').value = 640;
  // 高级选项
  document.getElementById('tf-optimizer').value = 'auto';
  document.getElementById('tf-lr0').value = '';
  document.getElementById('tf-mosaic').value = '';
  document.getElementById('tf-degrees').value = '';
  document.getElementById('tf-mixup').value = '';
  document.getElementById('tf-patience').value = 50;
  document.getElementById('tf-device').value = 'auto';
  localStorage.removeItem('train_last_backbone');
  toast('已恢复默认值','success');
}

function loadTrainJobs(){
  api('/api/train/jobs').then(function(res){
    trainJobs=(res.data&&res.data.jobs)||[];
    trainHasRunning=trainJobs.some(function(j){return j.status==='running';});
    renderTrainJobs();
  });
}

function renderTrainJobs(){
  var listEl=document.getElementById('train-job-list');
  if(!listEl) return;
  var kw=(document.getElementById('train-search').value||'').trim().toLowerCase();
  var sf=document.getElementById('train-status-filter').value;
  var jobs=trainJobs.filter(function(j){
    if(kw && (j.job_name||'').toLowerCase().indexOf(kw)<0) return false;
    if(sf && j.status!==sf) return false;
    return true;
  });
  document.getElementById('train-job-count').textContent=trainJobs.length;

  // 新建表单 / 进行中横幅
  var formCard=document.getElementById('train-form-card');
  var banner=document.getElementById('train-running-banner');
  var startBtn=document.getElementById('tf-start');
  if(trainHasRunning){
    if(formCard) formCard.style.opacity='0.55';
    if(startBtn){ startBtn.disabled=true; startBtn.textContent='有训练任务进行中'; }
    if(banner){
      var rj=trainJobs.find(function(j){return j.status==='running';});
      banner.style.display='block';
      var rep=rj?(rj.progress_epoch||0):0, rtot=rj?(rj.total_epochs||0):0;
      var rstage=(rep===0)
        ? '正在准备训练环境（扫描数据集 / AMP 校验），请稍候…'
        : ('第 '+rep+'/'+rtot+' 轮 · 预计剩余 '+fmtEta(rj?rj.eta_sec:null));
      banner.innerHTML='⏳ 正在训练：<b>'+(rj?rj.job_name:'')+'</b> · '+rstage+'。训练期间智能检测与工业控制的推理入口均已锁定。';
    }
  }else{
    if(formCard) formCard.style.opacity='1';
    if(startBtn){ startBtn.disabled=false; startBtn.textContent='开始训练'; }
    if(banner) banner.style.display='none';
  }

  if(!jobs.length){
    listEl.innerHTML='<div class="train-empty">暂无训练任务</div>';
    return;
  }

  listEl.innerHTML=jobs.map(function(j){
    var st=TRAIN_STATUS[j.status]||TRAIN_STATUS.unregistered;
    var checked=trainChecked[j.job_name]?'checked':'';
    var checkbox=trainEdit
      ? '<input type="checkbox" class="train-cb" data-name="'+j.job_name+'" '+checked+(j.status==='running'?' disabled':'')+' onchange="onTrainCb(this)">'
      : '';
    var mid='';
    if(j.status==='running'){
      var pct=j.total_epochs?Math.round((j.progress_epoch||0)/j.total_epochs*100):0;
      var preparing=(j.progress_epoch||0)===0;
      mid='<div class="tj-progress"><div class="tj-bar'+(preparing?' tj-bar-indet':'')+'" style="width:'+(preparing?100:pct)+'%"></div></div>'+
           '<div class="tj-sub">'+(preparing
             ? '正在准备训练环境（扫描数据集 / AMP 校验）…'
             : ('第 '+j.progress_epoch+' / '+j.total_epochs+' 轮 · 预计剩余 '+fmtEta(j.eta_sec)))+'</div>';
    }else{
      mid='<div class="tj-sub">'+
        (j.best_map50!=null?('best mAP50：<b>'+j.best_map50+'</b>'):'')+
        (j.elapsed_sec?(' · 耗时 '+fmtDuration(j.elapsed_sec)):'')+
        (j.dataset_name?(' · 数据集 '+j.dataset_name):'')+'</div>';
    }
    var btns=jobActionButtons(j);
    return '<div class="train-job-card">'+
      '<div class="tj-left">'+checkbox+'</div>'+
      '<div class="tj-main">'+
        '<div class="tj-top"><span class="tj-name">'+j.job_name+'</span>'+
        '<span class="tj-status '+st.cls+'">'+st.text+'</span></div>'+
        mid+
      '</div>'+
      '<div class="tj-actions">'+btns+'</div>'+
    '</div>';
  }).join('');
}

function jobActionButtons(j){
  var b='';
  b+='<button class="btn btn-primary btn-sm" onclick="openTrainDetail(\''+j.job_name+'\')">详情</button>';
  if(j.status==='running'){
    b+='<button class="btn btn-ghost btn-sm" style="color:#e57373;border-color:#5a3a3a" onclick="openTrainStop(\''+j.job_name+'\')">停止</button>';
  }else{
    var canResume=(j.status==='paused'||j.status==='failed'||j.status==='interrupted')&&j.has_last&&!trainHasRunning;
    if(j.status==='paused'||j.status==='failed'||j.status==='interrupted'){
      b+='<button class="btn btn-ghost btn-sm" '+(canResume?'':'disabled title="'+(trainHasRunning?'有训练任务进行中':'暂无可续训权重')+'"')+
        ' onclick="resumeTrainJob(\''+j.job_name+'\')">断点续训</button>';
    }
    if(j.has_report){
      b+='<button class="btn btn-ghost btn-sm" onclick="viewTrainReport(\''+j.job_name+'\')">查看报告</button>';
    }
    if(j.status==='done'&&j.has_best){
      b+='<button class="btn btn-ghost btn-sm" onclick="openTrainExport(\''+j.job_name+'\')">导出模型</button>';
    }
    b+='<button class="btn btn-ghost btn-sm" style="color:#e57373;border-color:#5a3a3a" onclick="deleteTrainJob(\''+j.job_name+'\')">删除</button>';
  }
  return b;
}

function startTrainJob(){
  // 提交前先挡一道：数据集还没划分（train/val 为空）就训练会直接失败
  var _dsName = document.getElementById('tf-dataset').value;
  var _ds = (trainDatasets || []).find(function(d){ return d.name === _dsName; });
  if(_ds && (!_ds.train_count || !_ds.val_count)){
    toast('数据集「' + _dsName + '」尚未划分（训练集 ' + (_ds.train_count||0) +
          ' 张 / 验证集 ' + (_ds.val_count||0) + ' 张），请先点数据集右侧的「自动划分」', 'error');
    return;
  }
  var payload={
    backbone_file: document.getElementById('tf-backbone').value,
    dataset_name: document.getElementById('tf-dataset').value,
    job_name: document.getElementById('tf-name').value.trim(),
    epochs: document.getElementById('tf-epochs').value,
    batch: document.getElementById('tf-batch').value,
    imgsz: document.getElementById('tf-imgsz').value,
    optimizer: document.getElementById('tf-optimizer').value,
    lr0: document.getElementById('tf-lr0').value.trim(),
    mosaic: document.getElementById('tf-mosaic').value.trim(),
    degrees: document.getElementById('tf-degrees').value.trim(),
    mixup: document.getElementById('tf-mixup').value.trim(),
    patience: document.getElementById('tf-patience').value,
    device: document.getElementById('tf-device').value
  };
  if(!payload.backbone_file||!payload.dataset_name){ toast('请选择基础模型和数据集','error'); return; }
  var btn=document.getElementById('tf-start');
  btn.disabled=true; btn.textContent='正在启动…';
  api('/api/train/jobs',{method:'POST',body:JSON.stringify(payload)}).then(function(res){
    if(res.data&&res.data.ok){
      toast('训练任务已启动','success');
      ['tf-name','tf-lr0','tf-mosaic','tf-degrees','tf-mixup'].forEach(function(id){document.getElementById(id).value='';});
      loadTrainJobs();
    }else{
      toast((res.data&&res.data.msg)||'启动失败','error');
      btn.disabled=false; btn.textContent='开始训练';
    }
  }).catch(function(){ btn.disabled=false; btn.textContent='开始训练'; });
}

// ---- 编辑模式 / 批量选择 ----
function toggleTrainEdit(){
  trainEdit=!trainEdit;
  document.getElementById('btn-edit-train').textContent=trainEdit?'完成':'编辑';
  document.getElementById('btn-checkall-train').style.display=trainEdit?'':'none';
  document.getElementById('btn-batchdel-train').style.display=trainEdit?'':'none';
  if(!trainEdit) trainChecked={};
  renderTrainJobs();
}
function onTrainCb(cb){ trainChecked[cb.getAttribute('data-name')]=cb.checked; updateTrainCheckAllLabel(); }
function updateTrainCheckAllLabel(){
  var selectable=trainJobs.filter(function(j){return j.status!=='running';});
  var n=selectable.filter(function(j){return trainChecked[j.job_name];}).length;
  var btn=document.getElementById('btn-checkall-train');
  btn.textContent=(n>0&&n===selectable.length)?'取消全选':'全选';
}
function toggleTrainCheckAll(){
  var selectable=trainJobs.filter(function(j){return j.status!=='running';});
  var allSel=selectable.length>0&&selectable.every(function(j){return trainChecked[j.job_name];});
  selectable.forEach(function(j){ trainChecked[j.job_name]=!allSel; });
  renderTrainJobs();
}
function deleteSelectedTrainJobs(){
  var names=Object.keys(trainChecked).filter(function(n){return trainChecked[n];});
  if(!names.length){ toast('请先勾选任务','error'); return; }
  confirmDialog('删除所选训练任务','确定删除选中的 '+names.length+' 个训练任务吗？<br>仅删除训练输出目录与记录，<b>已入库的模型不会被删除</b>。',function(){
    Promise.all(names.map(function(n){
      return api('/api/train/jobs/'+encodeURIComponent(n),{method:'DELETE'});
    })).then(function(){
      trainChecked={}; toast('已删除 '+names.length+' 个任务','success');
      toggleTrainEdit(); loadTrainJobs();
    });
  });
}
function deleteTrainJob(name){
  confirmDialog('删除训练任务','确定删除任务「'+name+'」吗？<br>仅删除训练输出目录与记录，已入库的模型不会被删除。',function(){
    api('/api/train/jobs/'+encodeURIComponent(name),{method:'DELETE'}).then(function(res){
      if(res.data&&res.data.ok){ toast('已删除','success'); loadTrainJobs(); }
      else toast((res.data&&res.data.msg)||'删除失败','error');
    });
  });
}

// ---- 停止 / 续训 ----
function openTrainStop(name){
  trainStopTarget=name;
  document.getElementById('ts-text').textContent='任务「'+name+'」正在训练，请选择停止方式：';
  document.getElementById('train-stop-modal').classList.add('show');
}
function confirmTrainStop(mode){
  closeModal('train-stop-modal');
  if(!trainStopTarget) return;
  var name=trainStopTarget; trainStopTarget=null;
  api('/api/train/jobs/'+encodeURIComponent(name)+'/stop',{method:'POST',body:JSON.stringify({mode:mode})})
    .then(function(res){
      if(res.data&&res.data.ok){ toast(mode==='finish'?'已请求结束，将在本轮后收尾':'已请求暂停','success'); setTimeout(loadTrainJobs,1500); }
      else toast((res.data&&res.data.msg)||'操作失败','error');
    });
}
function resumeTrainJob(name){
  confirmDialog('确认断点续训',
    '将从该任务的 <b>last.pt</b> 断点恢复训练状态继续训练。<br><br>'+
    '· 若任务已完成设定轮次，续训可能直接结束，不会产生新的训练过程<br>'+
    '· 如需增加训练轮次，建议新建训练任务<br>'+
    '· 续训期间「智能检测」入口将被锁定，同一时间只能运行一个训练任务<br>'+
    '· 训练结束后会重新生成 best.pt、训练报告并入库模型<br><br>'+
    '确定要继续吗？',
    function(){
      api('/api/train/jobs/'+encodeURIComponent(name)+'/resume',{method:'POST'})
        .then(function(res){
          if(res.data&&res.data.ok){ toast('已从断点恢复训练','success'); loadTrainJobs(); }
          else toast((res.data&&res.data.msg)||'续训失败','error');
        });
    });
}
function viewTrainReport(name){
  window.open(API+'/api/train/jobs/'+encodeURIComponent(name)+'/report','_blank');
}

// ---- 模型导出 ----
function openTrainExport(name){
  trainExportTarget=name;
  document.getElementById('train-export-job').textContent=name;
  var grid=document.getElementById('train-export-grid');
  grid.innerHTML=TRAIN_EXPORT_FORMATS.map(function(f){
    return '<div class="export-opt" onclick="submitTrainExport(\''+f.fmt+'\')">'+
      '<div class="export-opt-name">'+f.name+'</div>'+
      '<div class="export-opt-desc">'+f.desc+'</div></div>';
  }).join('');
  openModal('train-export-modal');
}
function submitTrainExport(fmt){
  if(!trainExportTarget) return;
  var name=trainExportTarget; trainExportTarget=null;
  closeModal('train-export-modal');
  showLoading('正在导出 '+fmt.toUpperCase()+' 格式，请稍候…', 600);
  api('/api/train/jobs/'+encodeURIComponent(name)+'/export',{method:'POST',body:JSON.stringify({format:fmt})})
    .then(function(res){
      hideLoading();
      if(res.data&&res.data.ok){
        var fn=res.data.file_name||fmt;
        var sz=res.data.size_bytes?('（'+(res.data.size_bytes/1024/1024).toFixed(1)+' MB）'):'';
        toast('导出成功：'+fn+sz,'success');
        loadTrainJobs();
        if(document.getElementById('train-detail-modal').classList.contains('show')){
          openTrainDetail(name);
        }
      }else{
        toast((res.data&&res.data.msg)||'导出失败','error');
      }
    })
    .catch(function(){ hideLoading(); toast('导出请求失败','error'); });
}

// ---- 详情弹窗 ----
function openTrainDetail(name){
  api('/api/train/jobs/'+encodeURIComponent(name)).then(function(res){
    if(!res.data||!res.data.ok){ toast('任务不存在','error'); return; }
    renderTrainDetail(res.data.job);
    document.getElementById('train-detail-modal').classList.add('show');
  });
}
function row(k,v){ return '<tr><th>'+k+'</th><td>'+(v==null||v===''?'-':v)+'</td></tr>'; }
function renderTrainDetail(j){
  var st=TRAIN_STATUS[j.status]||TRAIN_STATUS.unregistered;
  document.getElementById('td-title').innerHTML=j.job_name+' <span class="tj-status '+st.cls+'">'+st.text+'</span>';
  var body=document.getElementById('td-body');

  var metrics='';
  if(j.best_map50!=null||j.last_map50_95!=null){
    metrics='<div class="td-section"><h4>产出指标</h4><table class="td-table"><tbody>'+
      row('best mAP50', j.best_map50)+
      row('mAP50-95（末轮）', j.last_map50_95)+
      row('Precision（末轮）', j.last_precision)+
      row('Recall（末轮）', j.last_recall)+
      row('最终 loss', j.final_loss)+
      row('结果行数', j.result_rows)+
      '</tbody></table></div>';
  }

  var artifacts=(j.artifacts&&j.artifacts.length)
    ? j.artifacts.map(function(a){return a.file+'（'+fmtSize(a.size_bytes)+'）';}).join('<br>')
    : '训练开始后生成';
  var libStatus = j.model_file ? ('已入库：'+j.model_file) : '未入库';

  var live='';
  if(j.status==='running'){
    live='<div class="td-section"><h4>实时进度</h4><table class="td-table"><tbody>'+
      row('当前轮', ((j.progress_epoch||0)===0)?('准备中（0 / '+j.total_epochs+'）'):((j.progress_epoch||0)+' / '+j.total_epochs))+
      row('预计剩余', ((j.progress_epoch||0)===0)?'扫描数据集 / AMP 校验中':fmtEta(j.eta_sec))+
      row('当前 mAP50', j.best_map50)+
      row('当前 loss', j.final_loss)+
      '</tbody></table></div>';
  }

  body.innerHTML=
    '<div class="td-grid">'+
      '<div class="td-section"><h4>基本信息</h4><table class="td-table"><tbody>'+
        row('任务名', j.job_name)+
        row('数据集', j.dataset_name)+
        row('基础模型', j.backbone_file)+
        row('创建人', j.created_by)+
        row('开始时间', j.started_at||j.created_at)+
        row('结束时间', j.finished_at)+
        row('总耗时', fmtDuration(j.elapsed_sec))+
      '</tbody></table></div>'+
      '<div class="td-section"><h4>超参数</h4><table class="td-table"><tbody>'+
        row('epochs', j.epochs)+row('batch', j.batch)+row('imgsz', j.imgsz)+
        row('optimizer', j.optimizer)+row('lr0', j.lr0)+row('mosaic', j.mosaic)+
        row('degrees', j.degrees)+row('mixup', j.mixup)+row('patience', j.patience)+
        row('device', j.device)+
      '</tbody></table></div>'+
    '</div>'+
    live+metrics+
    '<div class="td-grid">'+
      '<div class="td-section"><h4>产物文件</h4><div>'+artifacts+'</div><div style="margin-top:8px">模型库：'+libStatus+'</div></div>'+
      '<div class="td-section"><h4>日志尾部</h4><pre class="td-log">'+(j.log_tail||'暂无日志')+'</pre></div>'+
    '</div>';

  var foot=document.getElementById('td-foot');
  var fb='';
  if(j.status==='running'){
    fb='<button class="btn btn-ghost" style="color:#e57373;border-color:#5a3a3a" onclick="closeModal(\'train-detail-modal\');openTrainStop(\''+j.job_name+'\')">停止训练</button>';
  }else{
    var canResume=(j.status==='paused'||j.status==='failed'||j.status==='interrupted')&&j.has_last&&!trainHasRunning;
    if(j.has_last) fb+='<button class="btn btn-ghost" '+(canResume?'':'disabled')+' onclick="closeModal(\'train-detail-modal\');resumeTrainJob(\''+j.job_name+'\')">断点续训</button>';
    if(j.has_report) fb+='<button class="btn btn-ghost" onclick="viewTrainReport(\''+j.job_name+'\')">查看完整报告</button>';
    if(j.status!=='running') fb+='<button class="btn btn-ghost" style="color:#e57373;border-color:#5a3a3a" onclick="closeModal(\'train-detail-modal\');deleteTrainJob(\''+j.job_name+'\')">删除任务</button>';
  }
  fb+='<button class="btn btn-primary" onclick="closeModal(\'train-detail-modal\')">关闭</button>';
  foot.innerHTML=fb;
}

// ---- 智能检测训练锁定 ----
function setDetectLocked(locked, info){
  state.detectLocked = !!locked;
  var banner = document.getElementById('detect-lock-banner');
  if(banner){
    banner.style.display = locked ? '' : 'none';
    if(locked){
      document.getElementById('detect-lock-job').textContent = (info && info.job_name) || '';
      document.getElementById('detect-lock-eta').textContent = (info && info.eta) || '计算中';
    }
  }
  var view = document.getElementById('view-detect');
  if(view){
    view.querySelectorAll('button.btn').forEach(function(b){
      if(locked) b.setAttribute('disabled','disabled');
      else b.removeAttribute('disabled');
    });
    view.querySelectorAll('input[type=file]').forEach(function(i){
      if(locked) i.setAttribute('disabled','disabled');
      else i.removeAttribute('disabled');
    });
    view.querySelectorAll('.source-tab').forEach(function(t){
      if(locked) t.classList.add('disabled');
      else t.classList.remove('disabled');
    });
  }
  // 工控页的摄像头推理同样受训练锁约束 —— 否则训练期间用户仍能在工控页开推理抢 GPU
  ['ind-cam-start', 'ind-infer-start'].forEach(function(id){
    var el = document.getElementById(id);
    if(!el) return;
    if(locked){
      el.setAttribute('disabled', 'disabled');
      el.title = '训练任务进行中，推理功能已锁定';
    } else {
      el.removeAttribute('disabled');
      el.title = '';
    }
  });
  // 工控页横幅：与智能检测页保持一致的提示样式
  var ibanner = document.getElementById('industrial-lock-banner');
  if(ibanner){
    ibanner.style.display = locked ? '' : 'none';
    if(locked){
      var ij = document.getElementById('industrial-lock-job');
      var ie = document.getElementById('industrial-lock-eta');
      if(ij) ij.textContent = (info && info.job_name) || '';
      if(ie) ie.textContent = (info && info.eta) || '计算中';
    }
  }
  // 训练开始时若工控页正在推理，自动停掉，避免占用显卡
  if(locked && _ind.inferOn){
    indStopInfer();
    toast('训练已开始，工控页推理已自动停止');
  }
}
function checkDetectLock(){
  api('/api/train/lock-status').then(function(res){
    var d=res.data;
    if(d&&d.ok&&d.locked){
      var info = {job_name:d.job_name, eta:fmtEta(d.eta_sec)};
      var wasLocked = state.detectLocked;
      setDetectLocked(true, info);
      if(!wasLocked){ showTrainLockModal(info.eta, info.job_name); }
    }else{
      if(state.detectLocked){
        setDetectLocked(false);
        toast('训练已完成，智能检测已恢复','success');
      }
    }
  }).catch(function(){});
}
function showTrainLockModal(eta, name){
  var m=document.getElementById('train-lock-modal');
  if(!m){
    m=document.createElement('div'); m.className='modal-mask'; m.id='train-lock-modal';
    m.innerHTML='<div class="modal modal-sm">'+
      '<div class="modal-head"><h3>推理功能暂不可用</h3></div>'+
      '<div class="modal-body">'+
        '<div style="text-align:center;font-size:40px;margin:6px 0 12px">⏳</div>'+
        '<p style="text-align:center;margin:0 0 6px;font-size:15px">正在训练模型，请稍后使用</p>'+
      '<p style="text-align:center;margin:0 0 8px;color:var(--text-3);font-size:12.5px">智能检测与工业控制的摄像头推理均已锁定</p>'+
        '<p style="text-align:center;margin:0;color:var(--text-3);font-size:13px">训练任务：<b data-name></b></p>'+
        '<p style="text-align:center;margin:8px 0 0;color:#e0b366;font-size:14px">预计等待：<b data-eta></b></p>'+
      '</div>'+
      '<div class="modal-foot"><button class="btn btn-primary" style="margin:0 auto" onclick="closeModal(\'train-lock-modal\')">知道了</button></div>'+
    '</div>';
    document.body.appendChild(m);
  }
  m.querySelector('[data-eta]').textContent=eta;
  m.querySelector('[data-name]').textContent=name||'';
  m.classList.add('show');
}

// ==================== 自定义动作组（高级行程模式） ====================
// 交互：位置/功能做成卡片 -> 拖到画布摆放 -> 平滑曲线连接 -> 按连线顺序运行
// 配色：蓝色=位置卡/主链，绿色=功能卡/随行动作，跨色禁止连接
var _ag = {
  open: false,
  mode: 'normal',        // normal / advanced
  groups: [],
  waypoints: [],
  poses: {},             // 姿态标定状态（当前模式）
  classGroupMap: {},     // 类别 -> 动作组 id（高级模式）
  currentId: null,
  graph: {nodes: [], edges: []},
  seq: 0,
  drag: null,            // {id, ox, oy}
  link: null,            // {fromId, kind}
  linkPos: null,
  jointVals: [1500, 1500, 1500, 1500, 1500],
  jointTouch: 0,         // 最近一次手动操作编辑器滑块的时间戳（避免同步抢值）
  wasRunning: false,     // 上一轮是否在运行（用于"刚结束"时弹一次完成通知）
  lastRunError: '',      // 已弹过通知的错误（避免轮询重复弹）
  runSeen: false,        // 本页是否已收到过至少一次运行态（决定首帧是否静默）
};

var AG_BLUE = '#4f8ef7';       // 姿态卡 + 主链端点
var AG_PURPLE = '#9b7cf0';     // 途经点卡（与姿态卡区分；其主链端点仍是蓝色）
var AG_GREEN = '#46c07a';      // 功能卡 + 随行动作端点
var AG_ACTION_LABELS = {suck: '吸气', release: '放气', off: '等待'};

function agIsAdvanced(){ return _ag.mode === 'advanced'; }

function agNodeSize(n){ return n.type === 'action' ? {w: 120, h: 42} : {w: 150, h: 58}; }

function agPortPos(n, port){
  var s = agNodeSize(n);
  if(port === 'out'){ return {x: n.x + s.w, y: n.y + (n.type === 'action' ? 21 : 29)}; }
  if(port === 'mainIn'){ return {x: n.x, y: n.y + 42}; }
  if(port === 'actionIn'){ return {x: n.x, y: n.y + 16}; }
  return {x: n.x, y: n.y};
}

function agNodeLabel(n){
  if(n.type === 'pose'){ return '姿态 · ' + ((_ag.poses[n.ref] || {}).label || n.ref); }
  if(n.type === 'waypoint'){
    var w = (_ag.waypoints || []).find(function(x){ return x.id === n.ref; });
    return '途经点 · ' + (w ? w.name : ('#' + n.ref));
  }
  return AG_ACTION_LABELS[n.action] || n.action;
}

// ---------- 模式切换 ----------

function agSetMode(adv){
  fetch('/api/arm/advanced-mode', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled: !!adv})
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){
      _ag.mode = res.advanced_mode ? 'advanced' : 'normal';
      agOnModeChanged();
      // 立即拉一次状态：动作标定区/映射区随模式变化，不必等下一次轮询（消除几秒空窗）
      if(typeof indFetchStatus === 'function') indFetchStatus();
      toast(res.msg || ('已切换到' + (_ag.mode === 'advanced' ? '高级模式' : '普通模式')));
    } else { toast(res.msg || '切换失败'); }
  }).catch(function(){ toast('请求失败'); });
}

function agOnModeChanged(){
  agUpdateModeUI();
  if(agIsAdvanced()){ agLoadGroups(); } else { indRenderClasses(); }
}

function agUpdateModeUI(){
  var adv = agIsAdvanced();
  var nb = document.getElementById('mode-normal-btn');
  var ab = document.getElementById('mode-advanced-btn');
  if(nb) nb.className = 'source-tab' + (adv ? '' : ' active');
  if(ab) ab.className = 'source-tab' + (adv ? ' active' : '');
  var chip = document.getElementById('ind-mode-chip');
  if(chip) chip.style.display = adv ? '' : 'none';
  var edBtn = document.getElementById('ag-open-editor-btn');
  if(edBtn) edBtn.style.display = adv ? '' : 'none';
  // 行程（经原点/直达）开关：两种模式下都保持可切换。
  // 它只作用于"手动点姿态"与普通模式自动分拣；高级模式的动作组按连线执行，不受它影响
  // （作用范围详见「?」说明弹窗）。
  ['viahome-on-btn', 'viahome-off-btn'].forEach(function(id){
    var b = document.getElementById(id);
    if(b){
      b.style.opacity = '';
      b.style.pointerEvents = '';
      b.title = '仅作用于手动点姿态与普通模式自动分拣；动作组按连线执行';
    }
  });
  var titleEl = document.getElementById('ind-map-title');
  if(titleEl) titleEl.textContent = adv ? '模型类别与动作组映射' : '模型类别与放置位映射';
}

// ---------- 按钮状态联动（连接/运行状态驱动禁用态） ----------

function agSetBtnDisabled(id, dis, tip){
  var b = document.getElementById(id);
  if(!b) return;
  b.disabled = dis;
  b.title = dis ? (tip || '机械臂未连接') : '';
}

function agUpdateRunUI(run){
  run = run || _ag.runStatus || {};
  _ag.runStatus = run;
  var connected = !!_ind.connected;
  var running = !!run.running;
  // 动作组运行中把状态轮询临时加速：每步约 1~2s，1s 轮询仍会漏掉短步骤
  // （表现为"刚准备完就跳到第 2 步、第 1 步被吞掉"），这里加密到 600ms。
  // 结束后恢复默认 3s。
  // 仅在已连接时切换（未连接时本就不轮询）；statusTimer 意外丢失时也会借机自愈。
  _ind.agRunning = running;
  indSyncStatusPoll();   // 统一由"是否在用机械臂"决定节奏（动作组运行 600ms，空闲 20s 心跳）
  // 运行进度/结果展示（试运行后不再是"只有一个 toast"）
  var rs = document.getElementById('ag-run-status');
  if(rs){
    if(running){
      rs.textContent = '运行中：' + (run.group_name || '') + ' · 步骤 ' +
        (run.step || 0) + '/' + (run.step_total || 0) + (run.label ? (' · ' + run.label) : '') +
        (run.dur ? (' · ' + (run.dur / 1000).toFixed(1) + 's') : '');
      rs.style.color = 'var(--accent)';
      _ag.wasRunning = true;
      _ag.lastRunError = '';
    } else if(run.error){
      rs.textContent = '上次运行：' + run.error;
      rs.style.color = '#e0655a';
      // 只有"本页面会话内新出现"的错误才弹通知。
      // 服务端 error 会一直保留到下次运行，若首帧就弹，每次刷新都会把上次的失败再弹一遍。
      // 自动分拣运行时由 indUpdateSorterStatus 弹，这里不重复（否则连弹两条互相顶掉）
      // —— 急停/主动停止令动作组以 error='已中止' 收场，这不算"运行失败"，
      //    否则遮罩里点急停后仍会被这里补弹一次"动作组运行失败：已中止"
      if(_ag.runSeen && run.error !== _ag.lastRunError && !_ind.sorterRunning &&
         run.error !== '已中止' && !_ind.estop){
        toast('动作组运行失败：' + run.error, 'error');
      }
      _ag.lastRunError = run.error;
      _ag.wasRunning = false;
    } else {
      rs.textContent = '';
      // 刚结束且无错误 -> 弹一次完成通知
      if(_ag.wasRunning){
        _ag.wasRunning = false;
        _ag.lastRunError = '';
        // 自动分拣运行时由 indUpdateSorterStatus 弹通知（带类别/动作组名，信息更全），
        // 这里不再重复弹 —— 否则会连弹两条、后一条把前一条顶掉
        if(!_ind.sorterRunning){
          toast('动作组运行完成', 'success');
        }
      }
    }
  }
  // 试运行：需已连接、机械臂空闲、已选中动作组；停止：仅在运行中可用
  agSetBtnDisabled('ag-run-btn', !(connected && !running && !!_ag.currentId),
    connected ? (running ? '动作组运行中' : '请先选择动作组') : '机械臂未连接');
  agSetBtnDisabled('ag-stop-btn', !running, '当前没有正在运行的动作组');
  agSetBtnDisabled('ag-reset-btn', !connected);
  agSetBtnDisabled('ag-capture-btn', !connected);
  // 内置关节滑块（含 −/＋）
  var box = document.getElementById('ag-joints');
  if(box){
    var els = box.querySelectorAll('input[type=range], button');
    for(var i = 0; i < els.length; i++){ els[i].disabled = !connected; }
  }
  // 本页已收到过运行态：之后出现的新错误才允许弹通知（首帧静默）
  _ag.runSeen = true;
}

function agLoadGroups(cb){
  fetch('/api/arm/groups').then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ _ag.groups = res.groups || []; }
    return fetch('/api/arm/class-group-map');
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ _ag.classGroupMap = res.class_group_map || {}; }
    if(cb){ cb(); } else { indRenderClasses(); }
  }).catch(function(){});
}

function agOnClassGroupChange(cls, gid){
  var map = {};
  for(var k in _ag.classGroupMap){ map[k] = _ag.classGroupMap[k]; }
  if(gid){ map[cls] = parseInt(gid); } else { delete map[cls]; }
  fetch('/api/arm/class-group-map', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({class_group_map: map})
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ _ag.classGroupMap = res.class_group_map || {}; toast('已保存类别映射'); }
    else { toast(res.msg || '保存失败'); }
    indRenderClasses();
  }).catch(function(){ toast('请求失败'); });
}

// ---------- 编辑器开关 ----------

function agOpenEditor(){
  if(!agIsAdvanced()){ toast('请先切换到高级模式'); return; }
  _ag.open = true;
  showLoading('加载动作组...', 15);
  fetch('/api/arm/waypoints').then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ _ag.waypoints = res.waypoints || []; }
    return fetch('/api/arm/pose/list');
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ _ag.poses = res.poses || {}; }
    return fetch('/api/arm/groups');
  }).then(function(r){ return r.json(); }).then(function(res){
    hideLoading();
    if(res.ok){ _ag.groups = res.groups || []; }
    agRenderGroupSelect();
    agRenderPalette();
    agRenderJoints();
    // 弹窗顶栏的行程/速度控件按当前值渲染
    // （不渲染的话显示的是 HTML 里写死的初始文字，可能与实际设置不符）
    indRenderViaHome();
    indRenderMoveSpeed();
    if(_ag.groups.length){
      // 与下拉框保持一致：优先加载"上次选中的动作组"，
      // 只有该组已不存在（被删/换用户）才退回第一个。
      // 原先写死加载 groups[0]，导致下拉框显示 A 组、画布却是 B 组内容。
      var keepId = _ag.currentId;
      var still = _ag.groups.some(function(g){ return g.id === keepId; });
      agLoadGroup(still ? keepId : _ag.groups[0].id);
    } else {
      _ag.currentId = null;
      _ag.graph = {nodes: [], edges: []};
      _ag.selection = {};
      agResetHistory();
      agRenderCanvas();
    }
    agUpdateRunUI(res.run);
    openModal('action-editor');
    // 打开时把滑块初始化为机械臂真实姿态（不能写死 1500）
    if(_ind.connected){
      fetch('/api/arm/pose/read')
        .then(function(r){ return r.json(); })
        .then(function(res){
          if(res.ok && res.pose){
            _ag.jointTouch = 0;            // 初始化不受"刚手动操作"保护影响
            agSyncJointsFromPose(res.pose);
          }
        })
        .catch(function(){});
    }
  }).catch(function(){ hideLoading(); toast('加载失败'); });
}

function agCloseEditor(){
  _ag.open = false;
  closeModal('action-editor');
}

function agRenderGroupSelect(){
  var sel = document.getElementById('ag-group-select');
  if(!sel) return;
  sel.innerHTML = '';
  (_ag.groups || []).forEach(function(g){
    var o = document.createElement('option');
    o.value = g.id; o.textContent = g.name;
    sel.appendChild(o);
  });
  if(_ag.currentId) sel.value = _ag.currentId;
}

function agOnGroupChange(){
  var sel = document.getElementById('ag-group-select');
  if(!sel || !sel.value) return;
  agLoadGroup(parseInt(sel.value));
}

function agLoadGroup(id){
  _ag.currentId = id;
  // 同步下拉框选中值：保证"下拉框显示的组"永远等于"画布里实际加载的组"
  var _gs = document.getElementById('ag-group-select');
  if(_gs) _gs.value = String(id);
  fetch('/api/arm/groups/' + id).then(function(r){ return r.json(); }).then(function(res){
    if(!res.ok){ toast(res.msg || '读取失败'); return; }
    _ag.graph = res.graph || {nodes: [], edges: []};
    _ag.selection = {};
    agResetHistory();
    if(!_ag.graph.nodes) _ag.graph.nodes = [];
    if(!_ag.graph.edges) _ag.graph.edges = [];
    var maxSeq = 0;
    _ag.graph.nodes.forEach(function(n){ maxSeq = Math.max(maxSeq, parseInt(String(n.id).replace(/\D/g, '')) || 0); });
    _ag.seq = maxSeq;
    var used = document.getElementById('ag-used-by');
    if(used) used.textContent = (res.used_by && res.used_by.length) ? ('被引用：' + res.used_by.join('、')) : '未被任何类别引用';
    agRenderCanvas();
    agUpdateRunUI();
  }).catch(function(){ toast('请求失败'); });
}

function agNewGroup(){
  promptDialog('新建动作组', '请输入动作组名称', function(name){
    name = (name || '').trim();
    if(!name) return;
    // 把当前画布上已画好的卡片一起存进新组（先画后建也不丢）；画布为空则建空组
    fetch('/api/arm/groups', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: name, graph: _ag.graph})
    }).then(function(r){ return r.json(); }).then(function(res){
      if(res.ok){
        _ag.currentId = res.id;   // 画布内容保留，归属切换到新组
        agLoadGroups(function(){ agRenderGroupSelect(); });
        toast('已新建「' + name + '」');
      } else { toast(res.msg || '新建失败'); }
    }).catch(function(){ toast('请求失败'); });
  });
}

function agRenameGroup(){
  if(!_ag.currentId){ toast('请先选择动作组'); return; }
  var cur = (_ag.groups.find(function(g){ return g.id === _ag.currentId; }) || {}).name || '';
  promptDialog('重命名', '请输入新的名称', function(name){
    name = (name || '').trim();
    if(!name) return;
    fetch('/api/arm/groups', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id: _ag.currentId, name: name, graph: _ag.graph})
    }).then(function(r){ return r.json(); }).then(function(res){
      if(res.ok){
        // 重新加载动作组列表 + 立刻刷新记录列表：记录里存的是组 id，
        // 显示时实时查组名，改名后无需等轮询即可看到新名字
        agLoadGroups(function(){ agRenderGroupSelect(); indLoadSortRecords(); });
        toast('已重命名');
      }
      else { toast(res.msg || '失败'); }
    }).catch(function(){ toast('请求失败'); });
  }, cur);   // 第 4 参：预填当前名称
}

// ===== 画布卡片单步执行（▶）=====
// 只运行这一张卡片：姿态卡->走到该姿态；途经点卡->走到该点位；
// 功能卡->执行吸气/放气/停止。行程（近远点/直达）由后端读用户偏好，与外面开关一致。
function agRunNode(id){
  var n = (_ag.graph.nodes || []).find(function(x){ return x.id === id; });
  if(!n){ toast('卡片不存在'); return; }
  if(!_ind.connected){ toast('机械臂未连接'); return; }
  if(_ind.busy){ toast('机械臂正忙，请稍候'); return; }
  var label = agNodeLabel(n);
  var url = '/api/arm/pose/goto', body = {};
  if(n.type === 'pose'){
    url = '/api/arm/pose/goto';
    body = {name: n.ref};
  } else if(n.type === 'waypoint'){
    var w = (_ag.waypoints || []).find(function(x){ return x.id === n.ref; });
    if(!w || !w.pwm){ toast('该途经点没有保存点位数据'); return; }
    url = '/api/arm/point/goto';
    body = {servos: w.pwm};
  } else {
    // 功能卡：吸气 / 放气 / 停止
    url = '/api/arm/pump';
    body = {action: n.action};
  }
  _ag.running = true;
  agUpdateRunUI(_ag.runStatus);
  fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})
    .then(function(r){ return r.json(); })
    .then(function(res){
      _ag.running = false;
      agUpdateRunUI(_ag.runStatus);
      if(res.ok) toast('已执行：' + label);
      else toast(res.msg || '执行失败', 'error');
    })
    .catch(function(){
      _ag.running = false;
      agUpdateRunUI(_ag.runStatus);
      toast('执行请求失败', 'error');
    });
}

// ===== 卡片库「更新」按钮：把机械臂当前位置存回姿态 / 途经点 =====
// 与外面动作标定区的「更新」按钮同功能（/api/arm/pose/save），编辑器里也能随手校准
function agUpdatePose(key){
  var st = _ag.poses[key] || {};
  var label = st.label || key;
  confirmDialog('更新姿态',
    '确定将「' + label + '」更新为机械臂当前各关节位置吗？', function(){
    showLoading('正在更新「' + label + '」...', 20);
    fetch('/api/arm/pose/save', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name: key})})
      .then(function(r){ return r.json(); })
      .then(function(res){
        hideLoading();
        if(!res.ok){ toast(res.msg || '更新失败', 'error'); return; }
        toast(res.msg || '已更新');
        // 刷新姿态标定状态（未标定 → 已标定，卡片恢复可拖拽）
        fetch('/api/arm/pose/list').then(function(r){ return r.json(); }).then(function(res2){
          if(res2.ok){ _ag.poses = res2.poses || {}; agRenderPalette(); }
        });
      })
      .catch(function(){ hideLoading(); toast('请求失败', 'error'); });
  });
}

function agUpdateWaypoint(id){
  var w = (_ag.waypoints || []).find(function(x){ return x.id === id; });
  var label = w ? w.name : ('#' + id);
  confirmDialog('更新途经点',
    '确定将「' + label + '」更新为机械臂当前各关节位置吗？', function(){
    showLoading('正在更新「' + label + '」...', 20);
    fetch('/api/arm/waypoints/' + id + '/update', {method:'POST'})
      .then(function(r){ return r.json(); })
      .then(function(res){
        hideLoading();
        if(!res.ok){ toast(res.msg || '更新失败', 'error'); return; }
        toast(res.msg || '已更新');
        fetch('/api/arm/waypoints').then(function(r){ return r.json(); }).then(function(res2){
          if(res2.ok){ _ag.waypoints = res2.waypoints || []; agRenderPalette(); }
        });
      })
      .catch(function(){ hideLoading(); toast('请求失败', 'error'); });
  });
}

function agDeleteGroup(){
  if(!_ag.currentId){ toast('请先选择动作组'); return; }
  var name = (_ag.groups.find(function(g){ return g.id === _ag.currentId; }) || {}).name || '';
  confirmDialog('删除动作组', '确定删除「' + name + '」吗？', function(){
    fetch('/api/arm/groups/' + _ag.currentId, {method: 'DELETE'})
      .then(function(r){ return r.json(); }).then(function(res){
        if(res.ok){
          _ag.currentId = null; _ag.graph = {nodes: [], edges: []};
          agResetHistory();
          agLoadGroups(function(){ agRenderGroupSelect(); agRenderCanvas(); });
          toast('已删除');
        } else { toast(res.msg || '删除失败'); }
      }).catch(function(){ toast('请求失败'); });
  });
}

function agSaveGroup(){
  if(!_ag.currentId){ toast('请先新建或选择动作组'); return; }
  var name = (_ag.groups.find(function(g){ return g.id === _ag.currentId; }) || {}).name || '';
  fetch('/api/arm/groups', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: _ag.currentId, name: name, graph: _ag.graph})
  }).then(function(r){ return r.json(); }).then(function(res){
    toast(res.msg || (res.ok ? '已保存' : '保存失败'));
  }).catch(function(){ toast('请求失败'); });
}

function agRunGroup(){
  if(!_ag.currentId){ toast('请先选择动作组'); return; }
  fetch('/api/arm/groups/' + _ag.currentId + '/run', {method: 'POST'})
    .then(function(r){ return r.json(); }).then(function(res){
      toast(res.msg || (res.ok ? '已开始运行' : '运行失败'));
      agUpdateRunUI(res.run);
    }).catch(function(){ toast('请求失败'); });
}

function agStopGroup(){
  fetch('/api/arm/groups/stop', {method: 'POST'})
    .then(function(r){ return r.json(); }).then(function(res){
      toast(res.msg || '已停止');
      agUpdateRunUI({running: false});   // 乐观更新，下一次轮询校正
    }).catch(function(){ toast('请求失败'); });
}

// ---------- 卡片库 ----------

function agRenderPalette(){
  var pBox = document.getElementById('ag-palette-poses');
  var wBox = document.getElementById('ag-palette-waypoints');
  var aBox = document.getElementById('ag-palette-actions');
  if(pBox){
    pBox.innerHTML = '';
    var names = Object.keys(_ag.poses || {});
    if(!names.length){
      pBox.innerHTML = '<div style="font-size:11px;color:var(--text-3)">暂无已标定姿态</div>';
    }
    names.forEach(function(k){
      var st = _ag.poses[k];
      var el = document.createElement('div');
      var ok = st && st.calibrated;
      el.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid ' + AG_BLUE +
        ';color:' + (ok ? AG_BLUE : 'var(--text-3)') + ';opacity:' + (ok ? '1' : '.5') + ';background:rgba(79,142,247,.08)';
      var nm = document.createElement('span');
      nm.style.cssText = 'flex:1;cursor:' + (ok ? 'pointer' : 'not-allowed') +
        ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nm.textContent = (st.label || k) + (ok ? '' : '（未标定）');
      if(ok){
        nm.onclick = function(){ agAddNode('pose', k); };
        nm.draggable = true;   // 拖到画布上按落点摆放
        nm.ondragstart = function(e){ agPaletteDragStart(e, 'pose', k); };
        // ⟳ 更新：把机械臂当前位置存回该姿态（同外面动作标定的「更新」按钮）
        var upd = document.createElement('span');
        upd.textContent = '⟳';
        upd.title = '更新：把机械臂当前位置存为该姿态';
        upd.style.cssText = 'cursor:pointer;color:#e8a24b;font-weight:700;padding:0 3px;flex-shrink:0';
        upd.onclick = function(e){ e.stopPropagation(); agUpdatePose(k); };
      }
      el.appendChild(nm);
      // ⟳ 统一放右侧（与途经点卡一致：名称在左、按钮在右）
      if(ok){ el.appendChild(upd); }
      pBox.appendChild(el);
    });
  }
  if(wBox){
    wBox.innerHTML = '';
    if(!(_ag.waypoints || []).length){
      wBox.innerHTML = '<div style="font-size:11px;color:var(--text-3)">暂无途经点</div>';
    }
    (_ag.waypoints || []).forEach(function(w){
      var el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;padding:5px 8px;' +
        'border-radius:6px;border:1px solid ' + AG_PURPLE + ';color:' + AG_PURPLE +
        ';background:rgba(155,124,240,.08)';
      var nm = document.createElement('span');
      nm.style.cssText = 'flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nm.textContent = w.name;
      nm.onclick = function(){ agAddNode('waypoint', w.id); };
      // 只给名称区域加拖拽：删除按钮 × 不该被拖动
      nm.draggable = true;
      nm.ondragstart = function(e){ agPaletteDragStart(e, 'waypoint', w.id); };
      // ⟳ 更新：把机械臂当前位置存回该途经点（同名覆盖，key/连线不变）
      var upd = document.createElement('span');
      upd.textContent = '⟳';
      upd.title = '更新：把机械臂当前位置存为该途经点';
      upd.style.cssText = 'cursor:pointer;color:#e8a24b;font-weight:700;padding:0 3px;flex-shrink:0';
      upd.onclick = function(e){ e.stopPropagation(); agUpdateWaypoint(w.id); };
      var del = document.createElement('span');
      del.textContent = '×';
      del.title = '删除该途经点卡片';
      del.style.cssText = 'cursor:pointer;color:#e0655a;font-weight:700;padding:0 2px;flex-shrink:0';
      del.onclick = function(e){ e.stopPropagation(); agDeleteWaypoint(w.id, w.name); };
      el.appendChild(nm);
      el.appendChild(upd);
      el.appendChild(del);
      wBox.appendChild(el);
    });
  }
  if(aBox){
    aBox.innerHTML = '';
    ['suck', 'release', 'off'].forEach(function(a){
      var el = document.createElement('div');
      el.style.cssText = 'font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid ' + AG_GREEN +
        ';color:' + AG_GREEN + ';cursor:pointer;background:rgba(70,192,122,.08)';
      el.textContent = AG_ACTION_LABELS[a];
      el.onclick = function(){ agAddNode('action', a); };
      el.draggable = true;
      el.ondragstart = function(e){ agPaletteDragStart(e, 'action', a); };
      aBox.appendChild(el);
    });
  }
}

function agDeleteWaypoint(wid, name){
  confirmDialog('删除途经点', '确定删除「' + name + '」吗？<br>已引用它的动作组会提示“途经点卡片不存在”，需重新选择。', function(){
    fetch('/api/arm/waypoints/' + wid, {method: 'DELETE'})
      .then(function(r){ return r.json(); }).then(function(res){
        if(!res.ok){ toast(res.msg || '删除失败'); return; }
        toast('已删除途经点「' + name + '」');
        fetch('/api/arm/waypoints').then(function(r2){ return r2.json(); }).then(function(r2){
          if(r2.ok){ _ag.waypoints = r2.waypoints || []; agRenderPalette(); agRenderCanvas(); }
        }).catch(function(){});
      }).catch(function(){ toast('请求失败'); });
  });
}

function agAddNode(type, refOrAction, at){
  _ag.seq += 1;
  var x, y;
  if(at){
    // 从卡片库拖入：以落点为中心摆放（卡片尺寸见 agNodeSize）
    var sz = agNodeSize({type: type});
    x = Math.max(0, Math.round(at.x - sz.w / 2));
    y = Math.max(0, Math.round(at.y - sz.h / 2));
  } else {
    // 点击添加：沿用原来的自动排布
    x = 40 + ((_ag.graph.nodes.length % 4) * 190);
    y = 40 + Math.floor(_ag.graph.nodes.length / 4) * 110;
  }
  var n = {id: 'n' + _ag.seq, type: type, x: x, y: y};
  if(type === 'pose'){ n.ref = refOrAction; n.duration = 1200; }
  else if(type === 'waypoint'){ n.ref = refOrAction; n.duration = 1200; }
  else { n.action = refOrAction; n.ms = 500; }
  _ag.graph.nodes.push(n);
  agRenderCanvas();
  agPushHistory();
}

// ---------- 卡片库拖拽到画布 ----------

function agPaletteDragStart(e, type, ref){
  // 用 HTML5 拖放：拖动不会触发 click，因此"点击添加"与"拖拽添加"可以共存
  try{
    e.dataTransfer.setData('text/plain', JSON.stringify({type: type, ref: ref}));
    e.dataTransfer.effectAllowed = 'copy';
  }catch(err){}
}

function agCanvasDragOver(e){
  if(!e.dataTransfer) return;
  e.preventDefault();                       // 必须阻止默认行为才允许放置
  e.stopPropagation();                      // 防止冒泡到父容器后被再次处理
  e.dataTransfer.dropEffect = 'copy';
  // 高亮的是**可视容器** ag-canvas 而不是内容层 ag-nodes：
  // ag-nodes 只有可视区那么大，画布滚动后露出的区域在它外面，
  // 高亮它会出现"提示框跟着滚动跑偏"的情况
  var cv = document.getElementById('ag-canvas');
  if(cv) cv.style.outline = '2px dashed ' + AG_BLUE;   // 高亮提示"可以放这里"
}

function agCanvasDragLeave(){
  var cv = document.getElementById('ag-canvas');
  if(cv) cv.style.outline = '';
  var b = document.getElementById('ag-nodes');
  if(b) b.style.outline = '';
}

function agCanvasDrop(e){
  e.preventDefault();
  e.stopPropagation();   // ⚠ 必须阻止冒泡：否则同一次拖放会被父容器的同名处理器再跑一遍
  var b0 = document.getElementById('ag-nodes');
  if(b0) b0.style.outline = '';
  var cv0 = document.getElementById('ag-canvas');
  if(cv0) cv0.style.outline = '';
  var raw = '';
  try{ raw = e.dataTransfer.getData('text/plain'); }catch(err){ return; }
  if(!raw) return;
  var d = null;
  try{ d = JSON.parse(raw); }catch(err){ return; }
  if(!d || !d.type) return;
  var box = document.getElementById('ag-nodes');
  if(!box) return;
  var rect = box.getBoundingClientRect();
  agAddNode(d.type, d.ref, {x: e.clientX - rect.left, y: e.clientY - rect.top});
}

// ---------- 画布 ----------

function agRenderCanvas(){
  agRenderNodes();
  agRenderEdges();
  agRenderSummary();
}

function agRenderNodes(){
  var box = document.getElementById('ag-nodes');
  if(!box) return;
  // 接收从卡片库拖过来的卡片（每次渲染重绑，容器本身不会被重建）
  // ⚠ 必须绑在**外层可视容器 ag-canvas** 上，不能绑内容层 ag-nodes：
  // ag-nodes 尺寸固定为可视区大小，画布滚动后新露出的区域在它外面，
  // 绑它的话那片区域收不到 dragover → 浏览器显示"禁止放置"标志，卡片放不下去。
  var cv = document.getElementById('ag-canvas');
  if(cv){
    cv.ondragover = agCanvasDragOver;
    cv.ondragleave = agCanvasDragLeave;
    cv.ondrop = agCanvasDrop;
  }
  // ⚠ 这里**不要**再给内容层 ag-nodes 绑第二份同样的处理器（以前绑过，重复-card 的根源）：
  // ag-nodes 是 ag-canvas 的子元素，drop 事件会向上冒泡到 ag-canvas，
  // 于是 agCanvasDrop 被执行两次，两次落点坐标相同 → 一次拖放生成两张重叠卡片。
  // 只绑外层即可：落在 ag-nodes 内部的事件同样能冒泡到 ag-canvas 被处理。
  // 空白处按下 -> 矩形框选（只在点中画布背景本身时触发，点到卡片不进这里）
  box.onmousedown = function(e){
    if(e.target !== box) return;
    var rect = box.getBoundingClientRect();
    _ag.marquee = {x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: null, y1: null};
    e.preventDefault();
  };
  box.innerHTML = '';
  _ag.graph.nodes.forEach(function(n){
    var s = agNodeSize(n);
    var isAction = n.type === 'action';
    // 卡片本体颜色区分类型（姿态=蓝、途经点=紫、功能=绿）；
    // 但端点仍按“角色”着色（主链=蓝、随行动作=绿），保证「蓝连蓝、绿连绿」规则不受影响
    var cardColor = isAction ? AG_GREEN : (n.type === 'waypoint' ? AG_PURPLE : AG_BLUE);
    var portColor = isAction ? AG_GREEN : AG_BLUE;
    var el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:' + n.x + 'px;top:' + n.y + 'px;width:' + s.w + 'px;height:' + s.h +
      'px;border:1.5px solid ' + cardColor + ';border-radius:8px;background:var(--card,#141a24);font-size:12px;' +
      'color:var(--text-1);display:flex;align-items:center;justify-content:center;cursor:move;user-select:none';
    el.dataset.nodeId = n.id;   // 供框选/选中样式按 id 定位卡片 DOM
    // 两个角标：左上=执行(▶)，右上=删除(×)。
    // 用 class 定位而非 children 索引——后续再加按钮也不会互相错位
    el.innerHTML = '<span style="padding:0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      agNodeLabel(n) + '</span>' +
      '<span class="ag-node-run" style="position:absolute;top:-7px;left:-7px;width:16px;height:16px;border-radius:50%;' +
      'background:#5aa96c;color:#fff;font-size:9px;line-height:16px;text-align:center;cursor:pointer" ' +
      'title="执行这一步：机械臂单独运行到这张卡片">▶</span>' +
      '<span class="ag-node-del" style="position:absolute;top:-7px;right:-7px;width:16px;height:16px;border-radius:50%;background:#e0655a;' +
      'color:#fff;font-size:11px;line-height:16px;text-align:center;cursor:pointer" ' +
      'title="删除这张卡片">×</span>';
    // 删除卡片
    el.querySelector('.ag-node-del').onclick = function(e){ e.stopPropagation(); agDeleteNode(n.id); };
    // 单步执行这张卡片
    el.querySelector('.ag-node-run').onclick = function(e){ e.stopPropagation(); agRunNode(n.id); };
    // 拖动卡片：若该卡已在框选集合中 -> 整组一起拖；否则单选它
    el.onmousedown = function(e){
      if(e.target && e.target.classList &&
         (e.target.classList.contains('ag-node-del') || e.target.classList.contains('ag-node-run'))) return;
      if(!_ag.selection) _ag.selection = {};
      if(!_ag.selection[n.id]){
        _ag.selection = {};
        _ag.selection[n.id] = true;
        agApplySelectionStyles();
      }
      var ids = Object.keys(_ag.selection);
      var orig = {};
      ids.forEach(function(id){
        var nn = _ag.graph.nodes.find(function(x){ return x.id === id; });
        if(nn) orig[id] = {x: nn.x, y: nn.y};
      });
      // cx0/cy0 = 按下时的**内容坐标**（画布滚动时 ag-nodes 的 rect 会变，
      // 用它算位移才能让卡片跟随滚动一起走，否则滚动后卡片位置会跳）
      var _r0 = box.getBoundingClientRect();
      _ag.drag = {ids: ids, x0: e.clientX, y0: e.clientY, orig: orig,
                  cx0: e.clientX - _r0.left, cy0: e.clientY - _r0.top};
      e.preventDefault();
    };
    // 输出端口
    var out = document.createElement('div');
    out.style.cssText = 'position:absolute;right:-7px;top:' + ((isAction ? 21 : 29) - 7) + 'px;width:14px;height:14px;' +
      'border-radius:50%;background:' + portColor + ';cursor:crosshair;border:2px solid var(--card,#141a24)';
    out.title = (isAction ? '绿色输出' : '蓝色输出') + '：按住拖到目标端点连线（断开请点左侧入口）';
    out.onmousedown = function(e){
      e.stopPropagation(); e.preventDefault();
      _ag.link = {fromId: n.id, kind: isAction ? 'action' : 'main'};
    };
    // 出口只负责"拉线"，单击不做任何断开：
    // 断开统一由左侧入口端点处理，避免左右都能断造成误操作（出口按下即进入拉线态，
    // 若松手即断，很容易在只想取消连线时误删已有连线）。
    // 这里仅取消本次未完成的拉线并清掉跟随的虚线。
    out.onmouseup = function(e){
      e.stopPropagation();
      if(_ag.drag){ _ag.drag = null; }
      if(_ag.link && _ag.link.fromId === n.id){
        _ag.link = null; _ag.linkPos = null;
        agRenderEdges();
      }
    };
    el.appendChild(out);
    if(!isAction){
      // 位置卡：左侧竖排两入口 —— 上绿（动作）、下蓝（主链）
      var ain = document.createElement('div');
      ain.style.cssText = 'position:absolute;left:-7px;top:9px;width:14px;height:14px;border-radius:50%;' +
        'background:' + AG_GREEN + ';cursor:crosshair;border:2px solid var(--card,#141a24)';
      ain.title = '绿色动作入口：接功能卡；单击可断开';
      // 入口必须拦住 mousedown，否则事件冒泡到卡片会误触发"拖动卡片"；
      // 且 mouseup 上的 stopPropagation 会拦掉 document 级 mouseup（负责结束拖拽），
      // 导致卡片被吸附在鼠标上甩不掉 —— 两个都得防
      ain.onmousedown = function(e){ e.stopPropagation(); e.preventDefault(); };
      ain.onmouseup = function(e){
        e.stopPropagation();
        if(_ag.drag){ _ag.drag = null; }
        // 正在拉线 -> 连上；没有拉线（单纯单击）-> 断开这个入口上的线
        if(_ag.link){ agTryConnect(n.id, 'actionIn'); }
        else { agRemoveEdgesAt(n.id, 'action', 'in'); }
      };
      el.appendChild(ain);
      var min = document.createElement('div');
      min.style.cssText = 'position:absolute;left:-7px;top:35px;width:14px;height:14px;border-radius:50%;' +
        'background:' + AG_BLUE + ';cursor:crosshair;border:2px solid var(--card,#141a24)';
      min.title = '蓝色主链入口：接上一张位置卡；单击可断开';
      min.onmousedown = function(e){ e.stopPropagation(); e.preventDefault(); };
      min.onmouseup = function(e){
        e.stopPropagation();
        if(_ag.drag){ _ag.drag = null; }
        if(_ag.link){ agTryConnect(n.id, 'mainIn'); }
        else { agRemoveEdgesAt(n.id, 'main', 'in'); }
      };
      el.appendChild(min);
    }
    box.appendChild(el);
  });
  agApplySelectionStyles();
}

// 按当前框选集合给卡片加/去高亮（白色外圈）
function agApplySelectionStyles(){
  var box = document.getElementById('ag-nodes');
  if(!box) return;
  var sel = _ag.selection || {};
  Array.prototype.forEach.call(box.children, function(el){
    var id = el.dataset && el.dataset.nodeId;
    if(id && sel[id]){
      el.style.boxShadow = '0 0 0 2px rgba(255,255,255,.6)';
    } else {
      el.style.boxShadow = '';
    }
  });
}

// ---------- 撤销 / 恢复 ----------
// 以画布快照为粒度：每次结构性变更（加卡/删卡/连线/断线/移动/整理/清空）压一帧，
// 上限 50 步防止内存膨胀。仅作用于本地画布，保存动作由「保存」按钮负责。

function agSnapshot(){
  return JSON.parse(JSON.stringify({nodes: _ag.graph.nodes, edges: _ag.graph.edges}));
}

function agPushHistory(){
  if(!_ag.history) _ag.history = [];
  if(_ag.hIndex == null) _ag.hIndex = _ag.history.length - 1;
  // 在历史中途做了新操作：丢弃后面的分支
  _ag.history = _ag.history.slice(0, _ag.hIndex + 1);
  _ag.history.push(agSnapshot());
  if(_ag.history.length > 50) _ag.history.shift();
  _ag.hIndex = _ag.history.length - 1;
  agUpdateUndoUI();
}

function agResetHistory(){
  _ag.history = [agSnapshot()];
  _ag.hIndex = 0;
  agUpdateUndoUI();
}

function agApplyHistory(){
  var snap = _ag.history[_ag.hIndex];
  if(!snap) return;
  _ag.graph = {
    nodes: JSON.parse(JSON.stringify(snap.nodes)),
    edges: JSON.parse(JSON.stringify(snap.edges))
  };
  _ag.selection = {};
  agRenderCanvas();
  agUpdateUndoUI();
}

function agUndo(){
  if(!_ag.history || _ag.hIndex == null || _ag.hIndex <= 0) return;
  _ag.hIndex -= 1;
  agApplyHistory();
}

function agRedo(){
  if(!_ag.history || _ag.hIndex == null || _ag.hIndex >= _ag.history.length - 1) return;
  _ag.hIndex += 1;
  agApplyHistory();
}

// 快捷键：仅在动作组编辑器打开时生效，且不在输入框内拦截
document.addEventListener('keydown', function(e){
  if(!_ag.open) return;
  var t = e.target || {};
  var tag = (t.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea' || t.isContentEditable) return;
  if(!(e.ctrlKey || e.metaKey)) return;
  var k = (e.key || '').toLowerCase();
  if(k === 'z' && !e.shiftKey){ e.preventDefault(); agUndo(); }
  else if(k === 'y' || (k === 'z' && e.shiftKey)){ e.preventDefault(); agRedo(); }
  else if(k === 'c'){ e.preventDefault(); agCopySelection(); }
  else if(k === 'v'){ e.preventDefault(); agPasteClipboard(); }
});

// ===== 画布卡片复制 / 粘贴（Ctrl+C / Ctrl+V）=====
// 剪贴板放在 _ag.clipboard 且**切换动作组不清空** —— 支持把卡片复制去别的动作组
function agCopySelection(){
  var ids = Object.keys(_ag.selection || {}).filter(function(id){ return _ag.selection[id]; });
  var nodes = (_ag.graph.nodes || []).filter(function(n){ return ids.indexOf(n.id) >= 0; });
  if(!nodes.length){ toast('请先框选要复制的卡片'); return; }
  // 记录相对位置（以选中集合左上角为基准），粘贴时保持原有布局
  var minX = Math.min.apply(null, nodes.map(function(n){ return n.x; }));
  var minY = Math.min.apply(null, nodes.map(function(n){ return n.y; }));
  _ag.clipboard = {
    nodes: JSON.parse(JSON.stringify(nodes)).map(function(n){
      return {o: n, dx: n.x - minX, dy: n.y - minY};
    }),
    // 只连带"两端都在选中集合内"的连线，避免粘出指向外部半截的线
    edges: (_ag.graph.edges || []).filter(function(e){
      return ids.indexOf(e.from) >= 0 && ids.indexOf(e.to) >= 0;
    }).map(function(e){ return JSON.parse(JSON.stringify(e)); })
  };
  toast('已复制 ' + nodes.length + ' 张卡片（切到其他动作组后 Ctrl+V 粘贴）');
}

function agPasteClipboard(){
  var clip = _ag.clipboard;
  if(!clip || !clip.nodes || !clip.nodes.length){ toast('剪贴板为空，请先 Ctrl+C 复制'); return; }
  if(!_ag.currentId && _ag.currentId !== 0){ toast('请先选择/保存一个动作组'); return; }
  // 连续粘贴时逐次错开，避免叠在一起
  _ag.pasteCount = (_ag.pasteCount || 0) + 1;
  var off = 24 * _ag.pasteCount;
  var map = {}, newIds = [];
  clip.nodes.forEach(function(item){
    _ag.seq += 1;
    var nid = 'n' + _ag.seq;
    map[item.o.id] = nid;
    var n = JSON.parse(JSON.stringify(item.o));
    n.id = nid;
    n.x = Math.max(0, item.dx + off);
    n.y = Math.max(0, item.dy + off);
    _ag.graph.nodes.push(n);
    newIds.push(nid);
  });
  (clip.edges || []).forEach(function(e){
    var ne = JSON.parse(JSON.stringify(e));
    ne.from = map[e.from];
    ne.to = map[e.to];
    if(ne.from && ne.to) _ag.graph.edges.push(ne);
  });
  _ag.selection = {};
  newIds.forEach(function(id){ _ag.selection[id] = true; });
  agPushHistory();
  agRenderCanvas();
  agApplySelectionStyles();
  toast('已粘贴 ' + newIds.length + ' 张卡片' + ((clip.edges || []).length ? ('（含 ' + clip.edges.length + ' 条连线）') : ''));
}

function agUpdateUndoUI(){
  var u = document.getElementById('ag-undo-btn');
  var r = document.getElementById('ag-redo-btn');
  var canU = !!(_ag.history && _ag.hIndex > 0);
  var canR = !!(_ag.history && _ag.hIndex != null && _ag.hIndex < _ag.history.length - 1);
  if(u){ u.disabled = !canU; u.title = canU ? '撤销 (Ctrl+Z)' : '没有可撤销的操作'; }
  if(r){ r.disabled = !canR; r.title = canR ? '恢复 (Ctrl+Y)' : '没有可恢复的操作'; }
}

// 单击端点 = 断开该端点上的连线（原先只能"连"不能"断"，除非用新连线覆盖）
// kind: 'main'（蓝色主链） / 'action'（绿色随行动作）
// dir:  'out'（该端点的出线） / 'in'（接到该端点的入线）
function agRemoveEdgesAt(nodeId, kind, dir){
  var before = (_ag.graph.edges || []).length;
  _ag.graph.edges = (_ag.graph.edges || []).filter(function(e){
    if((e.kind || 'main') !== kind) return true;
    return dir === 'out' ? (e.from !== nodeId) : (e.to !== nodeId);
  });
  var removed = before - (_ag.graph.edges || []).length;
  if(removed > 0){
    agRenderEdges();
    agPushHistory();
    toast('已断开 ' + removed + ' 条连线（记得点「保存」）');
  } else {
    toast('这个端点上还没有连线');
  }
}

function agTryConnect(toId, port){
  if(!_ag.link) return;
  var fromId = _ag.link.fromId, kind = _ag.link.kind;
  _ag.link = null; _ag.linkPos = null;
  // 颜色/类型合法性
  if(kind === 'action' && port !== 'actionIn'){
    toast('随行动作（绿色）只能接到位置卡的绿色动作入口'); agRenderEdges(); return;
  }
  if(kind === 'main' && port !== 'mainIn'){
    toast('主链（蓝色）只能接到位置卡的蓝色主链入口'); agRenderEdges(); return;
  }
  if(fromId === toId){ toast('不能连自己'); agRenderEdges(); return; }
  // 去掉同类型旧连线（保证出口≤1 / 入口≤1）
  _ag.graph.edges = _ag.graph.edges.filter(function(e){
    if(e.kind !== kind) return true;
    if(kind === 'main'){ return !(e.from === fromId || e.to === toId); }
    return !(e.from === fromId || e.to === toId);
  });
  _ag.graph.edges.push({from: fromId, to: toId, kind: kind});
  agRenderCanvas();
  agPushHistory();
}

function agDeleteEdge(idx){
  _ag.graph.edges.splice(idx, 1);
  agRenderCanvas();
}

function agDeleteNode(id){
  _ag.graph.nodes = _ag.graph.nodes.filter(function(n){ return n.id !== id; });
  _ag.graph.edges = _ag.graph.edges.filter(function(e){ return e.from !== id && e.to !== id; });
  agRenderCanvas();
  agPushHistory();
}

function agRenderEdges(){
  var svg = document.getElementById('ag-edges');
  if(!svg) return;
  var defs = '<defs>' +
    '<marker id="ag-ar-main" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="' + AG_BLUE + '"/></marker>' +
    '<marker id="ag-ar-act" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="' + AG_GREEN + '"/></marker>' +
    '</defs>';
  var body = '';
  _ag.graph.edges.forEach(function(e, i){
    var a = _ag.graph.nodes.find(function(n){ return n.id === e.from; });
    var b = _ag.graph.nodes.find(function(n){ return n.id === e.to; });
    if(!a || !b) return;
    var p1 = agPortPos(a, 'out');
    var p2 = agPortPos(b, e.kind === 'action' ? 'actionIn' : 'mainIn');
    var dx = Math.max(45, Math.abs(p2.x - p1.x) * 0.5);
    var d = 'M ' + p1.x + ' ' + p1.y + ' C ' + (p1.x + dx) + ' ' + p1.y + ', ' + (p2.x - dx) + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y;
    var color = e.kind === 'action' ? AG_GREEN : AG_BLUE;
    body += '<path d="' + d + '" stroke="' + color + '" stroke-width="2.2" fill="none" ' +
      'marker-end="url(#ag-ar-' + (e.kind === 'action' ? 'act' : 'main') + ')" ' +
      'style="pointer-events:stroke;cursor:pointer" onclick="agDeleteEdge(' + i + ')"><title>点击删除连线</title></path>';
  });
  if(_ag.link && _ag.linkPos){
    var a2 = _ag.graph.nodes.find(function(n){ return n.id === _ag.link.fromId; });
    if(a2){
      var q1 = agPortPos(a2, 'out'), q2 = _ag.linkPos;
      var ddx = Math.max(45, Math.abs(q2.x - q1.x) * 0.5);
      body += '<path d="M ' + q1.x + ' ' + q1.y + ' C ' + (q1.x + ddx) + ' ' + q1.y + ', ' + (q2.x - ddx) + ' ' + q2.y + ', ' + q2.x + ' ' + q2.y + '" stroke="' +
        (_ag.link.kind === 'action' ? AG_GREEN : AG_BLUE) + '" stroke-width="2" fill="none" stroke-dasharray="5 4"/>';
    }
  }
  svg.innerHTML = defs + body;
}

function agRenderSummary(){
  var el = document.getElementById('ag-summary');
  if(!el) return;
  var mainCount = _ag.graph.edges.filter(function(e){ return e.kind === 'main'; }).length;
  var actCount = _ag.graph.edges.filter(function(e){ return e.kind === 'action'; }).length;
  el.textContent = '卡片 ' + _ag.graph.nodes.length + ' 张 · 主链 ' + mainCount + ' 段 · 随行动作 ' + actCount + ' 个';
}

function agTidyLayout(){
  // 主链横向排一行；功能卡放在宿主位置卡【左上方】，让它的绿色出口正对
  // 宿主左侧的绿色动作入口 —— 连线短而直（原先功能卡与宿主同 x，
  // 出口在右侧、入口在左侧，绿线被迫斜跨整张卡，非常扭曲）；
  // 未连进主链的孤立卡统一排到主链下方一行。
  var next = {}, prev = {};
  _ag.graph.edges.forEach(function(e){
    if((e.kind || 'main') === 'main'){ next[e.from] = e.to; prev[e.to] = e.from; }
  });
  var start = _ag.graph.nodes.find(function(n){ return n.type !== 'action' && !prev[n.id]; });
  var order = [], cur = start ? start.id : null, guard = 0;
  while(cur && guard < 200){ order.push(cur); guard++; cur = next[cur]; }
  var orphans = _ag.graph.nodes.filter(function(n){ return order.indexOf(n.id) < 0; }).map(function(n){ return n.id; });

  var HOST_Y = 210, GAP = 190;
  order.forEach(function(id, i){
    var n = _ag.graph.nodes.find(function(x){ return x.id === id; });
    if(!n) return;
    n.x = 40 + i * GAP; n.y = HOST_Y;
  });
  // 功能卡：宿主左上方（功能卡宽 120，右移 -130 让出口对准宿主左缘的入口）
  _ag.graph.nodes.forEach(function(n){
    if(n.type !== 'action') return;
    var hostEdge = _ag.graph.edges.find(function(e){ return (e.kind || 'action') === 'action' && e.from === n.id; });
    var host = hostEdge ? _ag.graph.nodes.find(function(x){ return x.id === hostEdge.to; }) : null;
    if(host){
      n.x = Math.max(10, host.x - 130);
      n.y = host.y - 82;              // 功能卡高 42 + 40 间隙
    } else {
      n.x = 40 + Math.max(0, orphans.indexOf(n.id)) * 190;
      n.y = HOST_Y + 130;
    }
  });
  // 孤立位置卡/途经点：主链下方一行
  orphans.forEach(function(id, i){
    var n = _ag.graph.nodes.find(function(x){ return x.id === id; });
    if(n && n.type !== 'action'){ n.x = 40 + i * 190; n.y = HOST_Y + 130; }
  });
  agRenderCanvas();
  agPushHistory();
}

function agClearCanvas(){
  confirmDialog('清空画布', '确定清空当前画布上的所有卡片和连线吗？（不会删除已保存的动作组）', function(){
    _ag.graph = {nodes: [], edges: []};
    _ag.selection = {};
    agRenderCanvas();
    agPushHistory();
  });
}

// ---------- 内置关节滑块（与工控页一致：−/＋ + 一键重置） ----------

function agRenderJoints(){
  var box = document.getElementById('ag-joints');
  if(!box) return;
  if(box.children.length) return;   // 只渲染一次，避免拖动时重建
  box.innerHTML = '';
  for(var i = 0; i < 5; i++){
    (function(sid){
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px';
      var name = document.createElement('span');
      name.style.cssText = 'width:70px;font-size:12px;color:var(--text-2);flex-shrink:0';
      name.textContent = (typeof JOINT_NAMES !== 'undefined' && JOINT_NAMES[sid]) ? JOINT_NAMES[sid] : ('J' + (sid + 1));
      var minus = document.createElement('button');
      minus.className = 'btn btn-ghost btn-sm';
      minus.textContent = '−';
      minus.style.cssText = 'padding:2px 9px;flex-shrink:0;font-size:15px;font-weight:700;line-height:1';
      // 长按连续调节（与外面关节滑块一致）：按下先走一次，400ms 后按 120ms 重复。
      // 注意用 bindHoldButton 就不要再挂 onclick —— 否则单击会执行两遍
      bindHoldButton(minus, function(){ agStepJoint(sid, -10); });
      var slider = document.createElement('input');
      slider.type = 'range'; slider.min = 500; slider.max = 2500; slider.value = 1500;
      slider.className = 'ind-slider';
      slider.style.flex = '1';
      slider.id = 'ag-slider-' + sid;
      slider.oninput = function(){
        document.getElementById('ag-val-' + sid).textContent = this.value;
        _ag.jointVals[sid] = parseInt(this.value);
        _ag.jointTouch = Date.now();
      };
      slider.onchange = function(){ _ag.jointTouch = Date.now(); agMoveJoint(sid, this.value); };
      var plus = document.createElement('button');
      plus.className = 'btn btn-ghost btn-sm';
      plus.textContent = '+';
      plus.style.cssText = 'padding:2px 9px;flex-shrink:0;font-size:15px;font-weight:700;line-height:1';
      bindHoldButton(plus, function(){ agStepJoint(sid, 10); });
      var val = document.createElement('span');
      val.style.cssText = 'width:48px;font-size:12px;font-family:monospace;text-align:right;flex-shrink:0';
      val.id = 'ag-val-' + sid;
      val.textContent = '1500';
      row.appendChild(name); row.appendChild(minus); row.appendChild(slider);
      row.appendChild(plus); row.appendChild(val);
      box.appendChild(row);
    })(i);
  }
}

function agSetJointUI(sid, v){
  var sl = document.getElementById('ag-slider-' + sid);
  var ve = document.getElementById('ag-val-' + sid);
  if(sl) sl.value = v;
  if(ve) ve.textContent = v;
  _ag.jointVals[sid] = v;
}

function agStepJoint(sid, delta){
  var v = Math.max(500, Math.min(2500, _ag.jointVals[sid] + delta));
  _ag.jointTouch = Date.now();
  agSetJointUI(sid, v);
  agMoveJoint(sid, v);
}

// 把机械臂当前姿态同步进编辑器滑块（双向打通的关键）
function agSyncJointsFromPose(pose){
  if(!_ag.open || !pose) return;
  // 用户正在拖编辑器滑块时不抢值
  if(Date.now() - (_ag.jointTouch || 0) < 2500) return;
  for(var i = 0; i < 5; i++){
    var v = pose[i] != null ? pose[i] : pose[String(i)];
    if(v == null) continue;
    v = parseInt(v);
    if(parseInt(_ag.jointVals[i]) === v) continue;
    agSetJointUI(i, v);   // 仅更新 UI 与缓存，不下发指令
  }
}

function agMoveJoint(sid, pwm){
  // duration 用 150ms（与外面 stepJoint 一致）：
  // 原先是 600ms —— 长按每 120ms 下发一次，而每步要走 600ms，
  // 动作严重堆积，机械臂明显滞后、不跟手。短时长连发才能平滑跟随。
  fetch('/api/arm/move', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({servo_id: sid, pwm: parseInt(pwm), duration: 150})
  }).then(function(r){ return r.json(); }).then(function(res){
    if(!res.ok) return;
    // 编辑器滑块改动 -> 立即同步到工控页滑块（与 indMoveServo 对称，不再等 3 秒回读）
    var sl = document.getElementById('jslider-' + sid);
    var ve = document.getElementById('jval-' + sid);
    if(sl) sl.value = pwm;
    if(ve) ve.textContent = pwm;
  }).catch(function(){});
}

function agResetJoints(){
  for(var i = 0; i < 5; i++) agSetJointUI(i, 1500);
  fetch('/api/arm/move-batch', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({servos: {0: 1500, 1: 1500, 2: 1500, 3: 1500, 4: 1500}, duration: 800})
  }).then(function(r){ return r.json(); }).then(function(res){
    toast(res.msg || '所有关节已重置到中位');
    // 一并同步到工控页滑块
    if(res.ok){
      for(var i = 0; i < 5; i++){
        var sl = document.getElementById('jslider-' + i);
        var ve = document.getElementById('jval-' + i);
        if(sl) sl.value = 1500;
        if(ve) ve.textContent = 1500;
      }
    }
  }).catch(function(){ toast('重置失败'); });
}

function agCaptureWaypoint(){
  promptDialog('存为途经点卡', '给当前机械臂姿态起个名字', function(name){
    name = (name || '').trim();
    if(!name) return;
    fetch('/api/arm/waypoints/capture', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: name})
    }).then(function(r){ return r.json(); }).then(function(res){
      if(!res.ok){ toast(res.msg || '保存失败'); return; }
      toast('已保存途经点「' + name + '」');
      fetch('/api/arm/waypoints').then(function(r2){ return r2.json(); }).then(function(r2){
        if(r2.ok){ _ag.waypoints = r2.waypoints || []; agRenderPalette(); }
      }).catch(function(){});
    }).catch(function(){ toast('请求失败'); });
  });
}

// ---------- 全局鼠标事件（拖动 / 连线） ----------

// 框选时把选框更新到指定屏幕坐标；并在鼠标贴近画布边缘时自动滚动，
// 使超出可视区的卡片也能被框选到（原先拖到边缘画布不动，超出部分选不中）
function agUpdateMarquee(clientX, clientY){
  var box = document.getElementById('ag-nodes');
  var cv = document.getElementById('ag-canvas');
  if(!box || !_ag.marquee) return;
  var rect = box.getBoundingClientRect();
  // ag-nodes 会随画布滚动移动，故 rect.left 已含滚动偏移 → 得到的是内容坐标
  var x1 = Math.max(0, clientX - rect.left), y1 = Math.max(0, clientY - rect.top);
  var m = _ag.marquee; m.x1 = x1; m.y1 = y1;
  var selEl = document.getElementById('ag-marquee');
  if(!selEl){
    selEl = document.createElement('div');
    selEl.id = 'ag-marquee';
    selEl.style.cssText = 'position:absolute;display:none;border:1px dashed #4f8ef7;' +
      'background:rgba(79,142,247,.12);pointer-events:none;z-index:5';
    box.appendChild(selEl);
  }
  selEl.style.display = 'block';
  selEl.style.left = Math.min(m.x0, x1) + 'px';
  selEl.style.top = Math.min(m.y0, y1) + 'px';
  selEl.style.width = Math.abs(x1 - m.x0) + 'px';
  selEl.style.height = Math.abs(y1 - m.y0) + 'px';

  // ---- 边缘自动滚动（与拖动卡片共用 agEdgeAutoScroll）----
  agEdgeAutoScroll(clientX, clientY, function(){
    agUpdateMarquee(_ag.marqueePos.x, _ag.marqueePos.y);
  });
}

// 拖到画布边缘时自动滚动画布，让超出可视区的部分也能框选 / 也能把卡片拖过去。
// onScroll: 每次真正滚动后的回调（用于按最后的鼠标位置重算选框或卡片位置）
function agEdgeAutoScroll(clientX, clientY, onScroll){
  var cv = document.getElementById('ag-canvas');
  if(!cv){ agStopAutoScroll(); return; }
  var cvr = cv.getBoundingClientRect();
  var EDGE = 28, STEP = 26;
  var dx = 0, dy = 0;
  if(clientX < cvr.left + EDGE) dx = -STEP;
  else if(clientX > cvr.right - EDGE) dx = STEP;
  if(clientY < cvr.top + EDGE) dy = -STEP;
  else if(clientY > cvr.bottom - EDGE) dy = STEP;
  if(dx || dy){
    _ag.scrollDx = dx;
    _ag.scrollDy = dy;
    _ag.scrollCb = onScroll;
    if(!_ag.scrollTimer){
      _ag.scrollTimer = setInterval(function(){
        var c2 = document.getElementById('ag-canvas');
        if(!c2){ agStopAutoScroll(); return; }
        var bx = c2.scrollLeft, by = c2.scrollTop;
        c2.scrollLeft += (_ag.scrollDx || 0);
        c2.scrollTop += (_ag.scrollDy || 0);
        // 只在真的滚动了才回调（滚到尽头就停，避免空转）
        if((c2.scrollLeft !== bx || c2.scrollTop !== by) && _ag.scrollCb){
          _ag.scrollCb();
        }
      }, 30);
    }
  } else {
    agStopAutoScroll();
  }
}

function agStopAutoScroll(){
  if(_ag.scrollTimer){ clearInterval(_ag.scrollTimer); _ag.scrollTimer = null; }
  _ag.scrollDx = 0;
  _ag.scrollDy = 0;
  _ag.scrollCb = null;
}

// 拖动卡片：按**内容坐标**计算位移（画布滚动时 rect 会变，
// 这样滚动量与鼠标位移会叠加，卡片能一路被拖到远处）
function agApplyDrag(clientX, clientY){
  var box = document.getElementById('ag-nodes');
  if(!box || !_ag.drag) return;
  var rect = box.getBoundingClientRect();
  var dx = (clientX - rect.left) - _ag.drag.cx0;
  var dy = (clientY - rect.top) - _ag.drag.cy0;
  var moved = false;
  (_ag.drag.ids || []).forEach(function(id){
    var n = _ag.graph.nodes.find(function(x){ return x.id === id; });
    var o = _ag.drag.orig[id];
    if(n && o){
      n.x = Math.max(0, o.x + dx);
      n.y = Math.max(0, o.y + dy);
      moved = true;
    }
  });
  if(moved){ agRenderCanvas(); _ag.dragMoved = true; }
}

document.addEventListener('mousemove', function(e){
  // 矩形框选进行中：更新选框位置
  if(_ag.marquee){
    _ag.marqueePos = {x: e.clientX, y: e.clientY};
    agUpdateMarquee(e.clientX, e.clientY);
    return;
  }
  if(_ag.drag){
    _ag.dragPos = {x: e.clientX, y: e.clientY};
    agApplyDrag(e.clientX, e.clientY);
    // 拖到画布边缘同样自动滚动（原先只有框选会滚，拖卡片时超出部分拖不动）
    agEdgeAutoScroll(e.clientX, e.clientY, function(){
      agApplyDrag(_ag.dragPos.x, _ag.dragPos.y);
    });
    return;
  }
  if(_ag.link){
    var b2 = document.getElementById('ag-nodes');
    if(!b2) return;
    var r2 = b2.getBoundingClientRect();
    _ag.linkPos = {x: e.clientX - r2.left, y: e.clientY - r2.top};
    agRenderEdges();
  }
});

document.addEventListener('mouseup', function(){
  agStopAutoScroll();              // 停掉边缘自动滚动（框选/拖动共用）
  if(_ag.drag){
    // 拖动只在松手时压一帧历史（而不是每移动一帧都压）
    if(_ag.dragMoved) agPushHistory();
    _ag.drag = null; _ag.dragMoved = false;
  }
  if(_ag.link){ _ag.link = null; _ag.linkPos = null; agRenderEdges(); }
  // 矩形框选结束：按相交计算选中集合
  if(_ag.marquee){
    var m = _ag.marquee; _ag.marquee = null;
    var selEl = document.getElementById('ag-marquee');
    if(selEl) selEl.style.display = 'none';
    var x1 = (m.x1 == null) ? m.x0 : m.x1, y1 = (m.y1 == null) ? m.y0 : m.y1;
    if(Math.abs(x1 - m.x0) < 6 && Math.abs(y1 - m.y0) < 6){
      _ag.selection = {};            // 几乎没拖动 = 单击空白 -> 清空选择
    } else {
      var L = Math.min(m.x0, x1), T = Math.min(m.y0, y1);
      var R = Math.max(m.x0, x1), B = Math.max(m.y0, y1);
      _ag.selection = {};
      _ag.graph.nodes.forEach(function(n){
        var s = agNodeSize(n);
        // 卡片包围盒与选框相交即选中
        if(n.x < R && n.x + s.w > L && n.y < B && n.y + s.h > T){ _ag.selection[n.id] = true; }
      });
    }
    agApplySelectionStyles();
  }
});
