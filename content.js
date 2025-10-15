// iframe 내부에서만 실행되도록 체크
if (window.self !== window.top) {
    // iframe 안에서만 실행
    console.log('DoL 번역기: iframe 내부에서 실행 중');
    
    // 전역 변수
    let translationEnabled = true;
    let showTranslation = true;
    let isTranslating = false;
    let translationCache = new Map();
    let originalTextCache = new Map();
    let failedTranslations = new Map();
    let observer = null;
    let processedNodes = new WeakSet();
    let retryCount = 0;
    let retryScheduled = false;
    let retryTimer = null;
    const MAX_RETRIES = 20;
    const MAX_TRANSLATION_RETRIES = 3;
    const MAX_BATCH_RETRIES = 3;
    const CACHE_KEY = 'dol_translation_cache';
    const MAX_CACHE_SIZE = 10000; // 최대 캐시 항목 수

    // 캐시 로드 함수
    async function loadCache() {
        try {
            const result = await chrome.storage.local.get(CACHE_KEY);
            if (result[CACHE_KEY]) {
                const cacheData = result[CACHE_KEY];
                console.log(`📦 캐시 로드: ${Object.keys(cacheData).length}개 항목`);
                // 노드 정보는 저장하지 않고 번역문만 저장
                for (const [key, value] of Object.entries(cacheData)) {
                    translationCache.set(key, { translation: value, nodes: [] });
                }
            }
        } catch (error) {
            console.error('캐시 로드 실패:', error);
        }
    }


    // 캐시 저장 함수 (디바운스 적용)
    let saveTimer = null;
    async function saveCache() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                const cacheObject = {};
                let count = 0;
                
                // 최신 항목부터 저장 (LRU 방식)
                const entries = Array.from(translationCache.entries()).reverse();

                for (const [key, value] of entries) {
                    if (count >= MAX_CACHE_SIZE) break;

                    // 로컬 사전에 없는 항목만 영구 캐시에 저장
                    const trimmedKey = key.trim().toLowerCase();
                    if (typeof localDictionary === 'undefined' || !localDictionary.has(trimmedKey)) {
                        cacheObject[key] = value.translation;
                        count++;
                    }
                }
                
                if (count > 0) {
                    await chrome.storage.local.set({ [CACHE_KEY]: cacheObject });
                    console.log(`💾 캐시 저장: ${count}개 항목 (로컬 사전 제외)`);
                } else {
                    console.log('💾 캐시 저장: 저장할 새 항목이 없습니다.');
                }

            } catch (error) {
                console.error('캐시 저장 실패:', error);
            }
        }, 2000); // 2초 후 저장
    }

    // 캐시 통계 보기
    async function showCacheStats() {
        const result = await chrome.storage.local.get(CACHE_KEY);
        if (result[CACHE_KEY]) {
            const size = JSON.stringify(result[CACHE_KEY]).length;
            console.log(`📊 캐시 통계:
- 항목 수: ${Object.keys(result[CACHE_KEY]).length}개
- 데이터 크기: ${(size / 1024).toFixed(2)} KB`);
        }
    }

    // 캐시 초기화 함수
    async function clearCache() {
        await chrome.storage.local.remove(CACHE_KEY);
        translationCache.clear();
        console.log('🗑️ 캐시 초기화 완료');
    }

    /**
     * 특정 캐시 항목을 삭제하는 함수
     * @param {string} originalText - 삭제할 원문 텍스트
     */
    async function deleteCacheEntry(originalText) {
        if (!originalText || typeof originalText !== 'string') {
            console.error('❌ 삭제할 텍스트(원문)를 정확히 입력해주세요.');
            return;
        }

        // 1. 메모리 캐시에서 삭제
        if (translationCache.has(originalText)) {
            translationCache.delete(originalText);
            console.log(`✅ 메모리 캐시에서 "${originalText}" 항목을 삭제했습니다.`);
        } else {
            console.log(`- 메모리 캐시에 "${originalText}" 항목이 없습니다.`);
        }

        // 2. 영구 저장소(Local Storage) 캐시에서 삭제
        try {
            const result = await chrome.storage.local.get(CACHE_KEY);
            if (result[CACHE_KEY] && result[CACHE_KEY][originalText]) {
                delete result[CACHE_KEY][originalText];
                await chrome.storage.local.set({ [CACHE_KEY]: result[CACHE_KEY] });
                console.log(`💾 영구 캐시에서 "${originalText}" 항목을 삭제했습니다.`);
            } else {
                console.log(`- 영구 캐시에 "${originalText}" 항목이 없습니다.`);
            }
        } catch (error) {
            console.error('❌ 영구 캐시 삭제 중 오류 발생:', error);
        }
    }

    // 토글 버튼 생성 및 추가
    function createToggleButton() {
        const existingBtn = document.getElementById('dol-translation-toggle');
        if (existingBtn) {
            existingBtn.remove();
        }

        const button = document.createElement('button');
        button.id = 'dol-translation-toggle';
        button.textContent = 'Eng';

        button.addEventListener('click', () => {
            showTranslation = !showTranslation;
            button.textContent = showTranslation ? 'Eng' : 'Kor';
            toggleDisplayMode();
        });

        if (document.body) {
            document.body.appendChild(button);
            console.log('✅ 토글 버튼 생성됨');
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(button);
                console.log('✅ 토글 버튼 생성됨 (DOMContentLoaded)');
            });
        }
    }

    // 원문/번역문 표시 전환
    function toggleDisplayMode() {
        if (showTranslation) {
            console.log('🔄 번역문으로 전환');
            let restoredCount = 0;
            for (const [originalText, cachedItem] of translationCache.entries()) {
                const { translation, nodes } = cachedItem;
                
                if (nodes && nodes.length > 0 && document.contains(nodes[0])) {
                    nodes[0].textContent = translation;
                    for (let i = 1; i < nodes.length; i++) {
                        if (document.contains(nodes[i])) {
                            nodes[i].textContent = '';
                        }
                    }
                    restoredCount++;
                }
            }
            console.log(`- ${restoredCount}개의 번역문을 캐시에서 복원했습니다.`);
        } else {
            console.log('🔄 원문으로 전환');
            let toggledCount = 0;
            for (const [node, originalText] of originalTextCache.entries()) {
                if (document.contains(node)) {
                    node.textContent = originalText;
                    toggledCount++;
                } else {
                    originalTextCache.delete(node);
                }
            }
            console.log(`- ${toggledCount}개의 텍스트를 원문으로 복원했습니다.`);
        }
    }

    // 초기화
    async function init() {
        const settings = await chrome.storage.sync.get({
            translationEnabled: true
        });
        translationEnabled = settings.translationEnabled;

        if (translationEnabled) {
            console.log('DoL 번역기 초기화 중...');
            
            // 캐시 로드
            await loadCache();
            
            setTimeout(() => {
                createToggleButton();
            }, 1000);
            
            waitForStoryArea();
        }
    }

    // 스토리 영역이 로드될 때까지 대기
    function waitForStoryArea() {
        const storyArea = document.querySelector('#story');

        if (storyArea) {
            console.log('스토리 영역 발견: #story');
            retryCount = 0;
            startObserving();
        } else {
            retryCount++;
            if (retryCount < MAX_RETRIES) {
                console.log(`스토리 영역을 찾을 수 없습니다. 재시도 ${retryCount}/${MAX_RETRIES}...`);
                setTimeout(waitForStoryArea, 1000);
            } else {
                console.error('스토리 영역을 찾지 못했습니다.');
            }
        }
    }

    // 스토리 영역 감시 시작
    function startObserving() {
        if (observer) {
            observer.disconnect();
        }

        const storyArea = document.querySelector('#story');

        if (!storyArea) {
            console.error('스토리 영역을 찾을 수 없습니다.');
            return;
        }

        console.log('번역 감시 시작: #story');
        translateStoryArea();

        observer = new MutationObserver((mutations) => {
            if (isTranslating) return;
            
            let hasStoryChange = false;
            for (const mutation of mutations) {
                if (mutation.target === storyArea || storyArea.contains(mutation.target)) {
                    hasStoryChange = true;
                    break;
                }
            }
            
            if (hasStoryChange) {
                debounceTranslate();
            }
        });

        observer.observe(storyArea, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // 디바운스
    let debounceTimer;
    function debounceTranslate() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            translateStoryArea();
        }, 500);
    }

    /**
     * 번역문을 찾는 통합 함수 (로컬 사전 -> 캐시 순)
     * @param {string} text - 원문 텍스트
     * @returns {string|null} - 찾은 번역문 또는 null
     */
    function findTranslation(text) {
        // 1. 로컬 사전에서 먼저 검색
        const trimmedText = text.trim().toLowerCase();
        if (typeof localDictionary !== 'undefined' && localDictionary.has(trimmedText)) {
            return localDictionary.get(trimmedText);
        }

        // 2. 메모리 캐시에서 검색
        if (translationCache.has(text)) {
            return translationCache.get(text).translation;
        }
        
        // 3. 못 찾은 경우
        return null;
    }

    // 스토리 영역 번역
    async function translateStoryArea() {
        if (!translationEnabled || isTranslating) return;

        const storyArea = document.querySelector('#story');
        if (!storyArea) {
            console.error('스토리 영역을 찾을 수 없습니다.');
            return;
        }

        isTranslating = true;

        try {
            const textNodesToProcess = getTextNodes(storyArea)
                .filter(node => !processedNodes.has(node) && shouldTranslate(node.textContent));

            if (textNodesToProcess.length === 0) {
                isTranslating = false;
                return;
            }

            const parents = [...new Set(textNodesToProcess.map(n => n.parentElement).filter(p => p))];
            const batches = [];

            for (const parent of parents) {
                let currentBatch = [];
                for (const child of parent.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE && textNodesToProcess.includes(child)) {
                        currentBatch.push(child);
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        const style = window.getComputedStyle(child);
                        const tagName = child.tagName;
                        if (style.display === 'block' || ['BR', 'HR', 'P'].includes(tagName)) {
                            if (currentBatch.length > 0) batches.push(currentBatch);
                            currentBatch = [];
                        }
                    }
                }
                if (currentBatch.length > 0) batches.push(currentBatch);
            }

            console.log(`${batches.length}개의 번역 단위(배치) 발견`);

            let translatedCount = 0;
            let failedCount = 0;

            for (const nodes of batches) {
                const originalText = nodes.map(n => n.textContent).join('');
                if (!shouldTranslate(originalText)) continue;

                // 원문 텍스트를 originalTextCache에 미리 저장
                nodes.forEach(node => {
                    if (!originalTextCache.has(node)) {
                        originalTextCache.set(node, node.textContent);
                    }
                });

                // 1. 로컬 사전 및 캐시에서 번역문 찾아보기
                const foundTranslation = findTranslation(originalText);

                if (foundTranslation) {
                    // 번역문을 찾았으면 화면에 바로 적용
                    if (showTranslation) {
                        nodes[0].textContent = foundTranslation;
                        for (let i = 1; i < nodes.length; i++) nodes[i].textContent = '';
                    }
                    nodes.forEach(node => processedNodes.add(node));
                    
                    // 메모리 캐시에 노드 정보 업데이트 (중요)
                    if (translationCache.has(originalText)) {
                        translationCache.get(originalText).nodes = nodes;
                    } else {
                        translationCache.set(originalText, { translation: foundTranslation, nodes: nodes });
                    }

                    translatedCount++;
                    continue; // 다음 번역 단위로 넘어감
                }

                // 2. 못 찾았으면 API로 번역 요청
                const result = await translateWithRetry(originalText, nodes);
                if (result.success) {
                    translatedCount++;
                } else {
                    failedCount++;
                }
                await sleep(400);
            }

            console.log(`✅ 번역 완료: ${translatedCount}개 배치 성공, ${failedCount}개 배치 실패`);
            
            // 캐시 저장
            if (translatedCount > 0) {
                saveCache();
            }
            
            if (failedCount > 0 && !retryScheduled) {
                scheduleRetry();
            }

        } finally {
            isTranslating = false;
        }
    }

    // 재시도 스케줄링
    function scheduleRetry() {
        if (retryScheduled || failedTranslations.size === 0) return;
        retryScheduled = true;
        console.log(`⏳ 5초 후 실패한 번역 ${failedTranslations.size}개를 재시도합니다...`);
        retryTimer = setTimeout(() => {
            retryScheduled = false;
            retryFailedTranslations();
        }, 5000);
    }

    // 재시도 기능이 포함된 번역
    async function translateWithRetry(text, nodes, currentRetry = 0) {
        try {
            console.log(`번역 요청 (시도 ${currentRetry + 1}/${MAX_TRANSLATION_RETRIES}):`, text.substring(0, 50) + '...');
            const translation = await requestTranslation(text);
            if (translation) {
                translationCache.set(text, { translation, nodes });
                if (showTranslation) {
                    nodes[0].textContent = translation;
                    for (let i = 1; i < nodes.length; i++) nodes[i].textContent = '';
                }
                nodes.forEach(node => processedNodes.add(node));
                failedTranslations.delete(text);
                console.log('✓ 번역 성공:', translation.substring(0, 50) + '...');
                return { success: true };
            }
            throw new Error('번역 결과가 비어있습니다.');
        } catch (error) {
            console.error(`❌ 번역 실패 (${currentRetry + 1}/${MAX_TRANSLATION_RETRIES}):`, error.message);
            if (currentRetry < MAX_TRANSLATION_RETRIES - 1) {
                await sleep(1000);
                return await translateWithRetry(text, nodes, currentRetry + 1);
            } else {
                failedTranslations.set(text, { nodes, retryCount: 0 });
                console.error('❌ 최대 재시도 횟수 초과:', text.substring(0, 50) + '...');
                return { success: false };
            }
        }
    }

    // 실패한 번역 재시도
    async function retryFailedTranslations() {
        if (failedTranslations.size === 0) return;
        
        console.log(`🔄 실패한 번역 ${failedTranslations.size}개 재시도 중...`);
        const failedEntries = Array.from(failedTranslations.entries());
        let successCount = 0;
        let stillFailedCount = 0;
        
        for (const [text, data] of failedEntries) {
            const { nodes, retryCount } = data;
            
            if (!document.contains(nodes[0])) {
                failedTranslations.delete(text);
                continue;
            }
            if (translationCache.has(text) || retryCount >= MAX_BATCH_RETRIES) {
                failedTranslations.delete(text);
                continue;
            }
            
            const result = await translateWithRetry(text, nodes);
            if (result.success) {
                successCount++;
                failedTranslations.delete(text);
            } else {
                failedTranslations.set(text, { nodes, retryCount: retryCount + 1 });
                stillFailedCount++;
            }
            await sleep(400);
        }
        
        console.log(`🔄 재시도 완료: ${successCount}개 성공, ${stillFailedCount}개 여전히 실패`);
        
        // 캐시 저장
        if (successCount > 0) {
            saveCache();
        }
        
        if (failedTranslations.size > 0) {
            scheduleRetry();
        } else {
            console.log('✅ 모든 번역 작업 완료!');
        }
    }

    // 텍스트 노드 추출
    function getTextNodes(element) {
        const textNodes = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode: function(node) {
                const parent = node.parentElement;
                if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON'].includes(parent.tagName)) {
                    return NodeFilter.FILTER_REJECT;
                }

                // Saves 탭 영역(#saves-list-container) 제외
                if (parent.closest('#saves-list-container')) return NodeFilter.FILTER_REJECT;

                if (!node.textContent.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.offsetParent === null && parent.style.display !== 'contents') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }
        return textNodes;
    }

    // 번역 대상인지 확인
    function shouldTranslate(text) {
        const trimmed = text.trim().toLowerCase();
        if (trimmed.length < 2 && !['a', 'i'].includes(trimmed)) return false;

        const patterns = [
            /^\d+$/,
            /^[^\w\s]+$/,
            /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/,
            /^\d+°c$/,
            /^[a-df][+\-]?$/,
            /^[a-z]\*$/
        ];

        if (patterns.some((re) => re.test(trimmed))) return false;
        if (!/[a-z]/.test(trimmed)) return false;

        return true;
    }

    // 번역 요청
    function requestTranslation(text) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'translate', text: text }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response && response.success) {
                    resolve(response.translation);
                } else {
                    reject(new Error(response?.error || '번역 실패'));
                }
            });
        });
    }

    // 대기 함수
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async function forceRefresh() {
        console.log('🔄 수동 새로고침 요청 수신됨. 캐시를 지우고 새로 번역합니다.');
        
        // 1. 번역 중이면 중단하고, MutationObserver를 잠시 중지하여 충돌 방지
        if (isTranslating) {
            console.log('번역이 진행 중이므로 새로고침을 중단합니다.');
            return;
        }
        if (observer) observer.disconnect();

        // 2. 현재 번역된 모든 텍스트를 원문으로 되돌림
        showTranslation = false;
        toggleDisplayMode(); 
        showTranslation = true; // 다음 번역을 위해 상태를 다시 true로 설정

        // 3. 모든 캐시와 번역 기록을 초기화
        await clearCache(); // 영구 저장소 캐시와 메모리 캐시(translationCache) 삭제
        originalTextCache.clear();
        processedNodes = new WeakSet();
        failedTranslations.clear();
        
        console.log('🔄 모든 캐시를 지우고 번역을 다시 시작합니다.');
        
        // 4. 번역 프로세스를 다시 시작
        await translateStoryArea();

        // 5. 중지했던 MutationObserver를 다시 시작하여 화면 변화 감지
        startObserving();
    }


    // 설정 업데이트 메시지 수신
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'updateSettings') {
            translationEnabled = request.enabled;
            if (retryTimer) clearTimeout(retryTimer);
            retryScheduled = false;

            if (translationEnabled) {
                processedNodes = new WeakSet();
                retryCount = 0;
                if (!document.getElementById('dol-translation-toggle')) {
                    createToggleButton();
                }
                waitForStoryArea();
            } else {
                if (observer) observer.disconnect();
                const btn = document.getElementById('dol-translation-toggle');
                if (btn) btn.remove();
            }
            sendResponse({ success: true });
        } else if (request.action === 'showCacheStats') {
            showCacheStats();
            sendResponse({ success: true });
        } else if (request.action === 'clearCache') {
            clearCache();
            sendResponse({ success: true });
        } else if (request.action === 'forceRefresh') {
            forceRefresh();
            sendResponse({ success: true });
        }
    });

    // 콘솔에서 사용할 수 있는 유틸리티 함수 노출
    window.dolTranslator = {
        showStats: showCacheStats,
        clearCache: clearCache,
        delete: deleteCacheEntry,
        getCacheSize: () => translationCache.size
    };

    init();
} else {
    console.log('DoL 번역기: 메인 페이지 (iframe 외부) - 실행하지 않음');
}