(() => {
  let isRunning = false;
  let autoMode = false;
  let unfollowMode = false;
  let autoFarmMode = false;
  let autoModeInterval = null;
  let unfollowModeInterval = null;
  let autoFarmInterval = null;
  let autoModeFollowCount = 0;
  let unfollowModeCount = 0;
  let autoModeSeenUsers = new Set();
  let followedUsersList = [];
  let startTime = Date.now();
  
  let profileQueue = [];
  
  let isCoolingDown = false;
  let cooldownTimer = null;
  let countdownInterval = null;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomBetween = ([min, max]) => Math.floor(min + Math.random() * (max - min));
  
  const log = (message) => {
    console.log(`[Twitter Bot] ${message}`);
    const statusEl = document.getElementById("tw-bot-status");
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  const triggerCooldown = (resetTimeMs) => {
    if (isCoolingDown) return;
    isCoolingDown = true;
    
    let waitMs = 15 * 60 * 1000; 
    
    if (resetTimeMs && resetTimeMs > Date.now()) {
      waitMs = resetTimeMs - Date.now();
    }
    
    let secondsLeft = Math.ceil(waitMs / 1000);
    log(`[Rate Limit 429] Calculating cooldown...`);
    
    countdownInterval = setInterval(() => {
      secondsLeft--;
      if(secondsLeft <= 0) {
        clearInterval(countdownInterval);
      } else {
        const m = Math.floor(secondsLeft / 60);
        const s = secondsLeft % 60;
        const statusEl = document.getElementById("tw-bot-status");
        if(statusEl) {
          statusEl.textContent = `Sleeping. Time left: ${m}m ${s}s`;
        }
      }
    }, 1000);

    cooldownTimer = setTimeout(() => {
      isCoolingDown = false;
      clearInterval(countdownInterval);
      log("Cooldown ended. Resuming operations.");
    }, waitMs);
  };

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      if (response.status === 429) {
        const resetHeader = response.headers.get('x-rate-limit-reset');
        const resetTime = resetHeader ? parseInt(resetHeader, 10) * 1000 : null;
        triggerCooldown(resetTime);
      }
    } catch (e) {}
    return response;
  };

  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      if (this.status === 429) {
        const resetHeader = this.getResponseHeader('x-rate-limit-reset');
        const resetTime = resetHeader ? parseInt(resetHeader, 10) * 1000 : null;
        triggerCooldown(resetTime);
      }
    });
    return originalXHRSend.apply(this, arguments);
  };

  const hasVerifiedBadge = (element) => {
    const verifiedBadge = element.querySelector('[data-testid="icon-verified"]');
    if (verifiedBadge) return true;
    const svgPaths = element.querySelectorAll('svg path');
    for (const path of svgPaths) {
      if (path.getAttribute('d')?.includes('M20.396 11')) return true;
    }
    return false;
  };

  const extractUsername = (element) => {
    const text = element.textContent || "";
    const directMatch = text.match(/@([\w_]+)/);
    if (directMatch) return directMatch[1];
    
    const profileLink = element.querySelector('a[href^="/"]');
    if (profileLink) {
      const match = profileLink.getAttribute("href")?.match(/^\/([^\/]+)(?:\/|$)/);
      if (match && !match[1].includes('status')) return match[1];
    }
    return null;
  };

  const harvestProfiles = () => {
    const cells = document.querySelectorAll('[data-testid="UserCell"], article[data-testid="tweet"]');
    for (const cell of cells) {
      const link = cell.querySelector('a[href^="/"][role="link"]');
      if (link) {
        const href = link.getAttribute('href');
        if (href && href.split('/').length === 2 && !href.includes('/status/')) {
          const profileUrl = `${href}/followers`;
          if (!profileQueue.includes(profileUrl)) {
            profileQueue.push(profileUrl);
          }
        }
      }
    }
  };

  const collectFollowTargets = (seenUsers) => {
    const onlyVerified = document.getElementById('tw-verified-only')?.checked;
    const skipVerified = document.getElementById('tw-skip-verified')?.checked;
    const rawElements = [];
    
    // Genişletilmiş seçiciler ile ekrandaki tüm potansiyel takip butonları/hücreleri toplanır
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const userCells = Array.from(document.querySelectorAll('[data-testid="UserCell"]'));
    const allButtons = Array.from(document.querySelectorAll('button[data-testid$="-follow"]'));
    
    const allNodes = [...userCells, ...articles, ...allButtons];

    for (const node of allNodes) {
      if (node.dataset.autoFollowLocked === "true") continue;

      // Konteyner tespiti
      const container = node.closest('[data-testid="UserCell"]') || node.closest('article[data-testid="tweet"]') || node.closest('div[data-testid="cellInnerDiv"]');
      
      const isVerified = container ? hasVerifiedBadge(container) : hasVerifiedBadge(node);
      
      if (onlyVerified && !isVerified) continue;
      if (skipVerified && isVerified) continue; // Mavi tikliyse atla

      const username = container ? extractUsername(container) : extractUsername(node);
      if (!username) continue;

      let actionType = null;
      let triggerElement = null;

      // Doğrudan follow butonu mu?
      const followBtn = node.tagName === 'BUTTON' && node.getAttribute('data-testid')?.endsWith('-follow') 
        ? node 
        : container?.querySelector('button[data-testid$="-follow"]');

      if (followBtn) {
        actionType = 'direct';
        triggerElement = followBtn;
      } else if (container && container.tagName.toLowerCase() === 'article') {
        const menuButton = container.querySelector('button[data-testid="caret"]');
        if (menuButton) {
          actionType = 'menu';
          triggerElement = menuButton;
        }
      }

      if (triggerElement && !rawElements.some(item => item.username === username)) {
        rawElements.push({ node: container || node, triggerElement, actionType, username });
      }
    }
    
    const uniqueTargets = [];
    for (const item of rawElements) {
      const key = item.username ? `user-${item.username.toLowerCase()}` : `node-${Math.random()}`;
      if (!seenUsers.has(key)) {
        seenUsers.add(key);
        uniqueTargets.push(item);
      }
    }
    return uniqueTargets;
  };

  const isFollowingBack = (button) => {
    const container = button.closest('[data-testid="UserCell"]') || button.closest('div[role="button"]');
    if (!container) return false;
    const spans = container.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim().toLowerCase();
      if (text === 'seni takip ediyor' || text === 'follows you') return true;
    }
    return false;
  };

  const runAutoFollowCycle = async () => {
    if (!autoMode || isRunning || isCoolingDown) return;
    isRunning = true;
    
    const targets = collectFollowTargets(autoModeSeenUsers);
    
    if (targets.length === 0) {
      log("No accounts found. Scrolling down...");
      window.scrollBy({ top: window.innerHeight * 0.7, behavior: "smooth" });
      isRunning = false;
      return;
    }

    const batchTargets = targets.slice(0, 3);
    for (const target of batchTargets) {
      if (!autoMode || isCoolingDown) break; 
      try {
        const { node, triggerElement, actionType, username } = target;
        let success = false;

        if (actionType === 'direct') {
          triggerElement.click();
          success = true;
          await wait(randomBetween([1500, 2500]));
        } else if (actionType === 'menu') {
          triggerElement.click(); 
          await wait(500);
          
          const menuItems = Array.from(document.querySelectorAll('div[role="menuitem"]'));
          const followItem = menuItems.find(item => {
            const text = item.textContent?.toLowerCase();
            return text?.includes('takip et') || text?.includes('follow');
          });
          
          if (followItem) {
            followItem.click();
            success = true;
          } else {
            document.body.click();
          }
        }
        
        if (success) {
          node.dataset.autoFollowLocked = "true";
          autoModeFollowCount++;
          followedUsersList.push({ username, timestamp: Date.now() });
          
          if (!isCoolingDown) {
            log(`Followed: @${username} (Total: ${autoModeFollowCount})`);
            document.getElementById('tw-follow-btn').textContent = `Stop Auto Follow (${autoModeFollowCount})`;
          }
        }
        await wait(randomBetween([2000, 4000]));
      } catch (error) {
        console.error(error);
      }
    }
    isRunning = false;
  };

  const runAutoFarmCycle = async () => {
    if (!autoFarmMode || isRunning || isCoolingDown) return;
    isRunning = true;

    harvestProfiles();

    const targets = collectFollowTargets(autoModeSeenUsers);

    if (targets.length > 0) {
      const target = targets[0];
      try {
        const { node, triggerElement, actionType, username } = target;
        let success = false;

        if (actionType === 'direct') {
          triggerElement.click();
          success = true;
          await wait(randomBetween([1500, 2500]));
        } else if (actionType === 'menu') {
          triggerElement.click();
          await wait(500);
          
          const menuItems = Array.from(document.querySelectorAll('div[role="menuitem"]'));
          const followItem = menuItems.find(item => {
            const text = item.textContent?.toLowerCase();
            return text?.includes('takip et') || text?.includes('follow');
          });
          
          if (followItem) {
            followItem.click();
            success = true;
          } else {
            document.body.click();
          }
        }

        if (success) {
          node.dataset.autoFollowLocked = "true";
          autoModeFollowCount++;
          followedUsersList.push({ username, timestamp: Date.now() });
          log(`Farm Followed: @${username} (Total: ${autoModeFollowCount})`);
          document.getElementById('tw-farm-btn').textContent = `Stop Auto Farm (${autoModeFollowCount})`;
        }
        await wait(randomBetween([2000, 3000]));
        isRunning = false;
        return;
      } catch (e) {
        console.error(e);
      }
    } else {
      if (profileQueue.length > 0) {
        const nextProfileUrl = profileQueue.shift();
        log(`Switching queue: ${nextProfileUrl}`);
        
        window.history.pushState({}, '', nextProfileUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
        
        await wait(3000);
      } else {
        log("Queue empty, scrolling down...");
        window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
        await wait(2000);
      }
    }

    isRunning = false;
  };

  const runUnfollowCycle = async () => {
    if (!unfollowMode || isRunning || isCoolingDown) return;
    isRunning = true;
    
    const followingButtons = Array.from(document.querySelectorAll('button[data-testid$="-unfollow"]'));
    if (followingButtons.length === 0) {
      log("No unfollow buttons found. Scrolling down...");
      window.scrollBy({ top: window.innerHeight * 0.7, behavior: "smooth" });
      isRunning = false;
      return;
    }

    const nonFollowers = followingButtons.filter(button => !isFollowingBack(button));
    const batch = nonFollowers.slice(0, 3);

    for (const button of batch) {
      if (!unfollowMode || isCoolingDown) break;
      try {
        const ariaLabel = button.getAttribute('aria-label');
        const username = ariaLabel?.match(/@([\w_]+)/)?.[1] || 'unknown';
        
        button.click();
        await wait(600);
        
        const confirmButton = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (confirmButton) {
          confirmButton.click();
          unfollowModeCount++;
          if (!isCoolingDown) {
            log(`Unfollowed: @${username} (Total: ${unfollowModeCount})`);
            document.getElementById('tw-unfollow-btn').textContent = `Stop Auto Unfollow (${unfollowModeCount})`;
          }
        } else {
          document.body.click();
        }
        await wait(randomBetween([2500, 4000]));
      } catch (error) {
        console.error(error);
      }
    }
    isRunning = false;
  };

  const exportReport = () => {
    if (followedUsersList.length === 0) return alert("No accounts have been followed yet.");
    const dataStr = JSON.stringify({
      followedUsers: followedUsersList,
      totalCount: followedUsersList.length,
      startTime,
      endTime: Date.now()
    }, null, 2);
    
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `twitter-report-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const initUI = () => {
    const existing = document.getElementById("tw-bot-panel");
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = "tw-bot-panel";
    panel.style.cssText = "position:fixed;bottom:20px;right:20px;width:260px;background:#000;border:1px solid #fff;border-radius:0px;padding:16px;z-index:999999;box-shadow:0 5px 15px rgba(0,0,0,0.9);font-family:monospace;color:#fff;";

    const btnStyle = "width:100%;padding:10px;margin-bottom:8px;border:1px solid #fff;border-radius:0px;background:#fff;color:#000;font-family:monospace;font-weight:bold;cursor:pointer;text-transform:uppercase;font-size:11px;transition:0.2s;";

    panel.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:13px;color:#fff;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #333;padding-bottom:6px;font-weight:normal;">Auto Bot</h3>
      
      <div style="margin-bottom: 8px; display: flex; align-items: center; font-size: 11px;">
        <input type="checkbox" id="tw-verified-only" style="margin-right: 8px; width: 14px; height: 14px; accent-color: #000;">
        <label for="tw-verified-only" style="cursor: pointer;">Follow Verified Only</label>
      </div>

      <div style="margin-bottom: 12px; display: flex; align-items: center; font-size: 11px;">
        <input type="checkbox" id="tw-skip-verified" style="margin-right: 8px; width: 14px; height: 14px; accent-color: #000;">
        <label for="tw-skip-verified" style="cursor: pointer;">Skip Verified Accounts</label>
      </div>

      <button id="tw-follow-btn" style="${btnStyle}">Start Auto Follow</button>
      <button id="tw-farm-btn" style="${btnStyle}">Start Auto Farm</button>
      <button id="tw-unfollow-btn" style="${btnStyle}">Start Auto Unfollow</button>
      
      <div style="height:1px; background:#333; margin:12px 0;"></div>
      
      <button id="tw-report-btn" style="${btnStyle}">Export Report</button>
      
      <p id="tw-bot-status" style="margin:10px 0 0;font-size:10px;color:#ccc;min-height:14px;word-wrap:break-word;">System ready.</p>
    `;
    document.body.appendChild(panel);

    const toggleButtonState = (btn, isActive, baseText) => {
      if (isActive) {
        btn.style.background = "#000";
        btn.style.color = "#fff";
        btn.textContent = `Stop ${baseText.replace('Start ', '')}`;
      } else {
        btn.style.background = "#fff";
        btn.style.color = "#000";
        btn.textContent = baseText;
      }
    };

    document.getElementById("tw-follow-btn").addEventListener("click", (e) => {
      if (autoMode) {
        autoMode = false;
        clearInterval(autoModeInterval);
        toggleButtonState(e.target, false, "Start Auto Follow");
        log("Auto Follow stopped.");
      } else {
        autoMode = true;
        toggleButtonState(e.target, true, "Start Auto Follow");
        log("Started following...");
        
        runAutoFollowCycle();
        autoModeInterval = setInterval(runAutoFollowCycle, 5000);
      }
    });

    document.getElementById("tw-farm-btn").addEventListener("click", (e) => {
      if (autoFarmMode) {
        autoFarmMode = false;
        clearInterval(autoFarmInterval);
        toggleButtonState(e.target, false, "Start Auto Farm");
        log("Auto Farm stopped.");
      } else {
        autoFarmMode = true;
        toggleButtonState(e.target, true, "Start Auto Farm");
        log("Auto Farm started (Queue loop mode).");
        
        runAutoFarmCycle();
        autoFarmInterval = setInterval(runAutoFarmCycle, 6000);
      }
    });

    document.getElementById("tw-unfollow-btn").addEventListener("click", (e) => {
      if (unfollowMode) {
        unfollowMode = false;
        clearInterval(unfollowModeInterval);
        toggleButtonState(e.target, false, "Start Auto Unfollow");
        log("Auto Unfollow stopped.");
      } else {
        unfollowMode = true;
        toggleButtonState(e.target, true, "Start Auto Unfollow");
        log("Started unfollowing... (Non-followers)");
        
        runUnfollowCycle();
        unfollowModeInterval = setInterval(runUnfollowCycle, 5000);
      }
    });

    document.getElementById("tw-report-btn").addEventListener("click", exportReport);
  };

  initUI();
  console.log("System initialized. Rate limit protection active.");
})();
