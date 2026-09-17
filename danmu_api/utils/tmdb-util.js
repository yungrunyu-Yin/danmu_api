import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { httpGet } from "./http-util.js";
import { isNonChinese } from "./zh-util.js";
import { searchBangumiData } from './bangumi-data-util.js';

// ---------------------
// TMDB API 工具方法
// ---------------------

// 全局任务队列，用于管理并发请求的合并与中断
// Key: title, Value: { promise, controller, refCount }
const TMDB_PENDING = new Map();

// TMDB API 请求基础函数
async function tmdbApiGet(url, options = {}) {
  const tmdbApi = "https://api.tmdb.org/3/";
  const tartgetUrl = `${tmdbApi}${url}`;
  // 使用统一的代理 URL 构建方法
  const nextUrl = globals.makeProxyUrl(tartgetUrl);

  try {
    const response = await httpGet(nextUrl, {
      method: 'GET',
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      },
      signal: options.signal // 透传中断信号
    });
    if (response.status != 200) return null;

    return response;
  } catch (error) {
    // 如果是中断信号，抛出以供上层处理
    if (error.name === 'AbortError') {
       throw error;
    }
    log("error", "[system] [tmdb] Api error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}

// 使用 TMDB API 查询片名
export async function searchTmdbTitles(title, mediaType = "multi", options = {}) {
  const {
    page = 1,          // 起始页码
    maxPages = 3,      // 最多获取几页结果
    signal = null      // 中断信号
  } = options;

  // 如果指定了具体页码，只获取单页
  if (options.page !== undefined) {
    const url = `search/${mediaType}?api_key=${globals.tmdbApiKey}&query=${encodeURIComponent(title)}&language=zh-CN&page=${page}`;
    return await tmdbApiGet(url, { signal });
  }

  // 默认获取多页合并结果
  const allResults = [];

  for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
    // 检查是否中断
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const url = `search/${mediaType}?api_key=${globals.tmdbApiKey}&query=${encodeURIComponent(title)}&language=zh-CN&page=${currentPage}`;
    const response = await tmdbApiGet(url, { signal });

    if (!response || !response.data) {
      break;
    }

    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

    if (!data.results || data.results.length === 0) {
      break;
    }

    allResults.push(...data.results);

    // 如果当前页结果少于20条，说明没有更多结果了
    if (data.results.length < 20) {
      break;
    }
  }

  log("info", `[system] [tmdb] 共获取到 ${allResults.length} 条搜索结果（最多${maxPages}页）`);

  // 返回与原格式兼容的结构
  return {
    data: {
      results: allResults
    },
    status: 200
  };
}

// 使用 TMDB API 获取日语详情
export async function getTmdbJpDetail(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}?api_key=${globals.tmdbApiKey}&language=ja-JP`;
  return await tmdbApiGet(url, options);
}

// 使用 TMDB API 获取external_ids
export async function getTmdbExternalIds(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}/external_ids?api_key=${globals.tmdbApiKey}`;
  return await tmdbApiGet(url, options);
}

// 使用 TMDB API 获取别名
async function getTmdbAlternativeTitles(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}/alternative_titles?api_key=${globals.tmdbApiKey}`;
  return await tmdbApiGet(url, options);
}

// 从别名中提取中文别名相关函数
function extractChineseTitleFromAlternatives(altData, mediaType, queryTitle = "") {
  // 兼容不同 mediaType 的层级结构
  const titles = altData?.data?.results || altData?.data?.titles || [];
  if (!titles.length) return null;

  const cleanQuery = (queryTitle || "").toLowerCase().trim();
  const getStr = t => t.title || t.name || "";

  // 定义优先级判定规则数组，按先后顺序依次验证
  const priorityRules = [
    // 1. 最高优先级：精确命中用户搜索词
    t => cleanQuery && getStr(t).toLowerCase().trim() === cleanQuery,
    // 2. 地区优先级：按 CN > TW > HK > SG 顺序映射出 4 个规则函数
    ...['CN', 'TW', 'HK', 'SG'].map(region => 
      t => (t.iso_3166_1 || t.iso_639_1) === region && !isNonChinese(getStr(t))
    ),
    // 3. 兜底优先级：任何包含中文的别名
    t => !isNonChinese(getStr(t))
  ];

  // 遍历策略链，一旦有规则命中 (find 返回了对象)，立即提取并结束
  for (const rule of priorityRules) {
    const match = titles.find(rule);
    if (match) {
      const bestMatchTitle = getStr(match);
      log("info", `[system] [tmdb] 按优先级策略成功提取最佳中文别名: ${bestMatchTitle}`);
      return bestMatchTitle;
    }
  }

  return null;
}

// 别名获取判断相关函数
async function getChineseTitleForResult(result, signal, queryTitle = "") {
  const resultTitle = result.name || result.title || "";

  // 如果主标题正好完全匹配搜索词，直接返回
  if (queryTitle && resultTitle.toLowerCase().trim() === queryTitle.toLowerCase().trim()) {
    return resultTitle;
  }

  // 当主标题不是中文或者有搜索词但主标题没有完全命中时，才去拿别名池
  const needsAlternative = isNonChinese(resultTitle) || (queryTitle && resultTitle.toLowerCase().trim() !== queryTitle.toLowerCase().trim());

  if (!needsAlternative) {
    return resultTitle;
  }

  log("info", `[system] [tmdb] 尝试获取中文别名以寻找更优匹配 (当前标题: "${resultTitle}")`);

  const mediaType = result.media_type || (result.name ? "tv" : "movie");

  try {
    // 在发起别名请求前检查是否已中断
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const altResp = await getTmdbAlternativeTitles(mediaType, result.id, { signal });

    // 别名请求返回后再次检查（请求期间可能被中断）
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const chineseTitle = extractChineseTitleFromAlternatives(altResp, mediaType, queryTitle);

    if (chineseTitle) {
      log("info", `[system] [tmdb] 将使用中文别名进行相似匹配: ${chineseTitle}`);
      return chineseTitle;
    } else {
      log("info", `[system] [tmdb] 未找到中文别名，使用原标题: ${resultTitle}`);
      return resultTitle;
    }
  } catch (error) {
    // 遇到中断信号直接抛出
    if (error.name === 'AbortError') {
      throw error;
    }
    log("error", `[system] [tmdb] 获取别名失败: ${error.message}`);
    return resultTitle; // 失败则返回原标题
  }
}

// 使用TMDB API 查询日语原名，支持请求合并与引用计数控制
export async function getTmdbJaOriginalTitle(title, signal = null, sourceLabel = 'Unknown') {
  // 优化搜索关键词: 剥离 "Season 2", "第二季" 等后缀
  const cleanTitle = cleanSearchQuery(title);
  if (cleanTitle !== title) {
    log("info", `[system] [tmdb] 优化搜索关键词: "${title}" -> "${cleanTitle}"`);
  }

  // 优先尝试使用本地 Bangumi Data 获取原名与翻译，零延迟且无需 API Key
  if (globals.useBangumiData) {
    const localMatches = await searchBangumiData(cleanTitle, ['tmdb', 'bangumi', 'anidb']);
    if (localMatches && localMatches.length > 0) {
      // 按精确度排序：将正好匹配检索词的条目排在前面，避免子串混淆（如 "机动战士高达00" 匹配到 "机动战士高达0079"）
      if (localMatches.length > 1) {
        localMatches.sort((a, b) => {
          const aExact = a.titles.some(t => t === cleanTitle);
          const bExact = b.titles.some(t => t === cleanTitle);
          if (aExact && !bExact) return -1;
          if (!aExact && bExact) return 1;
          return 0;
        });
      }
      const m = localMatches[0]; // 取第一个最佳匹配
      const displayTitle = m.titles.find(t => t && t.includes(cleanTitle)) || m.titles[1] || m.title;
      const jaOriginalTitle = m.title; // Bangumi Data 的主标题就是原名

      log("info", `[system] [tmdb] Bangumi-Data 本地命中，提取原名成功: 原名=${jaOriginalTitle}, 别名=${displayTitle}（检索词：${cleanTitle}）`);
      return { title: jaOriginalTitle, cnAlias: displayTitle };
    }
  }

  if (!globals.tmdbApiKey) {
    log("info", "[system] [tmdb] 未配置API密钥，跳过TMDB网络搜索");
    return null;
  }

  // 检查是否已有相同关键词的搜索任务正在进行
  let task = TMDB_PENDING.get(cleanTitle);

  if (!task) {
    // 创建一个新的控制器，用于控制真正的后台网络请求
    const masterController = new AbortController();

    // 定义搜索核心逻辑
    const executeSearch = async () => {
      try {
        const backgroundSignal = masterController.signal;

        // 内部函数：判断单个媒体是否为动画或日语内容
        const isValidContent = (mediaInfo) => {
          const genreIds = mediaInfo.genre_ids || [];
          const genres = mediaInfo.genres || [];
          const allGenreIds = genreIds.length > 0 ? genreIds : genres.map(g => g.id);
          const originalLanguage = mediaInfo.original_language || '';
          const ANIMATION_GENRE_ID = 16;

          // 动画类型直接通过
          if (allGenreIds.includes(ANIMATION_GENRE_ID)) {
            return { isValid: true, reason: "明确动画类型(genre_id: 16)" };
          }

          // 日语内容通过（涵盖日剧、日影、日综艺）
          if (originalLanguage === 'ja') {
            return { isValid: true, reason: `原始语言为日语(ja),可能是日剧/日影/日综艺` };
          }

          return { 
            isValid: false, 
            reason: `非动画且非日语内容(language: ${originalLanguage}, genres: ${allGenreIds.join(',')})` 
          };
        };

        // 相似度计算函数
        const similarity = (s1, s2) => {
          // 标准化处理
          const normalize = (str) => {
            return str.toLowerCase()
              .replace(/\s+/g, '')
              .replace(/[：:、，。！？；""''（）【】《》]/g, '')
              .trim();
          };

          const n1 = normalize(s1);
          const n2 = normalize(s2);

          // 完全匹配
          if (n1 === n2) return 1.0;

          // 包含关系检查
          const shorter = n1.length < n2.length ? n1 : n2;
          const longer = n1.length >= n2.length ? n1 : n2;

          if (longer.includes(shorter) && shorter.length > 0) {
            // 如果有连词则得到一定加分
            const lengthRatio = shorter.length / longer.length;
            return 0.6 + (lengthRatio * 0.30);
          }

          // 编辑距离计算
          const longer2 = s1.length > s2.length ? s1 : s2;
          const shorter2 = s1.length > s2.length ? s2 : s1;
          if (longer2.length === 0) return 1.0;

          const editDistance = (str1, str2) => {
            str1 = str1.toLowerCase();
            str2 = str2.toLowerCase();
            const costs = [];
            for (let i = 0; i <= str1.length; i++) {
              let lastValue = i;
              for (let j = 0; j <= str2.length; j++) {
                if (i === 0) {
                  costs[j] = j;
                } else if (j > 0) {
                  let newValue = costs[j - 1];
                  if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                  }
                  costs[j - 1] = lastValue;
                  lastValue = newValue;
                }
              }
              if (i > 0) costs[str2.length] = lastValue;
            }
            return costs[str2.length];
          };

          return (longer2.length - editDistance(longer2, shorter2)) / longer2.length;
        };

        // 第一步：TMDB搜索
        log("info", `[system] [tmdb] 正在搜索 (Shared Task): ${cleanTitle}`);

        // 检查 masterController 是否已被中断
        if (backgroundSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        const respZh = await searchTmdbTitles(cleanTitle, "multi", { signal: backgroundSignal });

        if (!respZh || !respZh.data) {
          log("info", "[system] [tmdb] TMDB搜索结果为空");
          return null;
        }

        const dataZh = typeof respZh.data === "string" ? JSON.parse(respZh.data) : respZh.data;

        if (!dataZh.results || dataZh.results.length === 0) {
          log("info", "[system] [tmdb] TMDB未找到任何结果");
          return null;
        }

        // 第二步：数据清洗与类型严格过滤
        // 拦截所有非目标类型条目，确保只有动画或日文条目能进入核心匹配池
        const validResults = [];
        const invalidItems = [];

        for (const item of dataZh.results) {
          const validation = isValidContent(item);
          if (validation.isValid) {
            validResults.push(item);
          } else {
            const itemTitle = item.name || item.title || "未知";
            invalidItems.push(`${itemTitle}(${validation.reason})`);
          }
        }

        if (validResults.length === 0) {
          log("info", `[system] [tmdb] 数据清洗拦截: 搜索结果中没有任何目标类型(动画/日文)的内容`);
          return null;
        }

        log("info", `[system] [tmdb] 数据清洗完成: 保留 ${validResults.length} 个有效条目参与匹配，过滤 ${invalidItems.length} 个无关条目${invalidItems.length > 0 ? '，过滤详情: ' + invalidItems.join(', ') : ''}`);

        // 第三步：在干净的结果池中找到最相似的结果
        let bestMatch = null;
        let bestScore = -1;
        let bestMatchChineseTitle = null;
        let alternativeTitleFetchCount = 0; // 别名获取计数器
        const MAX_ALTERNATIVE_FETCHES = 5; // 最多获取5个别名
        let skipAlternativeFetch = false; // 是否跳过后续别名获取

        // 遍历经过严格过滤清洗后的干净结果池
        for (const result of validResults) {
          const resultTitle = result.name || result.title || "";
          if (!resultTitle) continue;

          // 先计算原标题的相似度
          const directScore = similarity(cleanTitle, resultTitle);
          const originalTitle = result.original_name || result.original_title || "";
          const originalScore = originalTitle ? similarity(cleanTitle, originalTitle) : 0;
          const initialScore = Math.max(directScore, originalScore);

          // 如果原标题已经100%匹配，标记跳过后续所有别名搜索
          if (initialScore === 1.0 && !skipAlternativeFetch) {
            skipAlternativeFetch = true;
            log("info", `[system] [tmdb] 匹配检查 "${resultTitle}" - 相似度: 100.00% (完全匹配，跳过后续所有别名搜索)`);
            if (initialScore > bestScore) {
              bestScore = initialScore;
              bestMatch = result;
              bestMatchChineseTitle = resultTitle;
            }
            continue;
          }

          // 获取可用的中文标题
          let chineseTitle;
          let finalScore;

          // 检查原标题是否与查询词绝对一致
          const isExactMatch = resultTitle.toLowerCase().trim() === cleanTitle.toLowerCase().trim();

          // 如果强制跳过了，或者它本身就是我们要找的精确匹配词，不再调接口拿别名
          if (skipAlternativeFetch || isExactMatch) {
            chineseTitle = resultTitle;
            finalScore = initialScore;

            if (skipAlternativeFetch && isExactMatch) {
              log("info", `[system] [tmdb] 匹配检查 "${resultTitle}" - 相似度: ${(finalScore * 100).toFixed(2)}% (已找到完全匹配，跳过别名搜索)`);
            } else {
              log("info", `[system] [tmdb] 匹配检查 "${resultTitle}" - 相似度: ${(finalScore * 100).toFixed(2)}%`);
            }
          } else {
            // 非完全匹配且未达到别名获取上限，尝试获取别名
            if (alternativeTitleFetchCount < MAX_ALTERNATIVE_FETCHES) {
              try {
                chineseTitle = await getChineseTitleForResult(result, backgroundSignal, cleanTitle);
                if (chineseTitle !== resultTitle) {
                  alternativeTitleFetchCount++;
                }
              } catch (error) {
                // 如果是中断错误，抛出
                if (error.name === 'AbortError') throw error;
                log("error", `[system] [tmdb] 处理结果失败: ${error.message}`);
                chineseTitle = resultTitle;
              }
            } else {
              chineseTitle = resultTitle;
              log("info", `[system] [tmdb] 已达到别名获取上限(${MAX_ALTERNATIVE_FETCHES})，使用原标题: ${resultTitle}`);
            }

            const finalDirectScore = similarity(cleanTitle, chineseTitle);
            finalScore = Math.max(finalDirectScore, originalScore);

            const displayInfo = chineseTitle !== resultTitle 
              ? `"${resultTitle}" (别名: ${chineseTitle})` 
              : `"${resultTitle}"`;
            log("info", `[system] [tmdb] 匹配检查 ${displayInfo} - 相似度: ${(finalScore * 100).toFixed(2)}%`);

            if (finalScore === 1.0 && !skipAlternativeFetch) {
              skipAlternativeFetch = true;
              log("info", `[system] [tmdb] 通过别名找到完全匹配，跳过后续所有别名搜索`);
            }
          }

          if (finalScore > bestScore) {
            bestScore = finalScore;
            bestMatch = result;
            bestMatchChineseTitle = chineseTitle;
          }
        }

        const MIN_SIMILARITY = 0.4;
        if (!bestMatch || bestScore < MIN_SIMILARITY) {
          log("info", `[system] [tmdb] 最佳匹配相似度过低或未找到匹配 (${bestMatch ? (bestScore * 100).toFixed(2) + '%' : 'N/A'}),跳过`);
          return null;
        }

        log("info", `[system] [tmdb] TMDB最佳匹配: ${bestMatchChineseTitle}, 相似度: ${(bestScore * 100).toFixed(2)}%`);

        // 第四步：获取日语详情
        const mediaType = bestMatch.media_type || (bestMatch.name ? "tv" : "movie");

        const detailResp = await getTmdbJpDetail(mediaType, bestMatch.id, { signal: backgroundSignal });

        let jaOriginalTitle;
        if (!detailResp || !detailResp.data) {
          jaOriginalTitle = bestMatch.name || bestMatch.title;
          log("info", `[system] [tmdb] 使用中文搜索结果标题: ${jaOriginalTitle}`);
        } else {
          const detail = typeof detailResp.data === "string" ? JSON.parse(detailResp.data) : detailResp.data;
          jaOriginalTitle = detail.original_name || detail.original_title || detail.name || detail.title;
          log("info", `[system] [tmdb] 找到日语原名: ${jaOriginalTitle}`);
        }

        // 返回对象，包含原名和别名
        return { title: jaOriginalTitle, cnAlias: bestMatchChineseTitle };

      } catch (error) {
         if (error.name === 'AbortError') {
             log("info", `[system] [tmdb] 后台搜索任务已完全终止 (${cleanTitle})`);
             return null;
         }
         log("error", "[system] [tmdb] Background Search error:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
         });
         return null;
      }
    };

    // 初始化任务结构
    task = {
      controller: masterController,
      refCount: 0,
      promise: executeSearch().finally(() => {
        // 无论成功失败，移除 Map 记录
        TMDB_PENDING.delete(cleanTitle);
      })
    };

    TMDB_PENDING.set(cleanTitle, task);
    log("info", `[system] [tmdb] 启动新搜索任务: ${cleanTitle}`);
  } else {
    log("info", `[system] [tmdb] 加入正在进行的搜索: ${cleanTitle} (${sourceLabel})`);
  }

  // 增加引用计数
  task.refCount++;

  // 定义退出任务及释放计数的处理函数
  const leaveTask = () => {
    // 再次获取任务确认其仍存在
    const currentTask = TMDB_PENDING.get(cleanTitle);
    if (currentTask === task) {
        task.refCount--;
        if (task.refCount <= 0) {
            log("info", `[system] [tmdb] 所有调用者已取消，终止后台请求: ${cleanTitle}`);
            task.controller.abort();
        }
    }
  };

  // 声明局部变量以供全局释放
  let abortHandler;

  // 处理调用者主动中断的监听
  if (signal) {
    if (signal.aborted) {
        leaveTask();
        log("info", `[system] [tmdb] 搜索已被中断 (Source: ${sourceLabel})`);
        return null;
    }
    signal.addEventListener('abort', leaveTask);
  }

  // 使用 Race 机制等待结果或用户中断
  try {
    const userAbortPromise = new Promise((_, reject) => {
        if (signal) {
            abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', abortHandler);
        }
    });

    return await Promise.race([task.promise, userAbortPromise]);

  } catch (error) {
    if (error.name === 'AbortError') {
      log("info", `[system] [tmdb] 搜索已被中断 (Source: ${sourceLabel})`);
      return null;
    }
    log("error", `[system] [tmdb] 搜索异常: ${error.message}`);
    return null;
  } finally {
    // 释放并移除终止信号监听器，防止发生内存泄漏
    if (signal) {
      signal.removeEventListener('abort', leaveTask);
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}

/**
 * 查询 TMDB 获取中文标题
 * @param {string} title - 标题
 * @param {number|string} season - 季数（可选）
 * @param {number|string} episode - 集数（可选）
 * @returns {Promise<string>} 返回中文标题，如果查询失败则返回原标题
 */

  /**
 * 查询 TMDB 获取可靠的中文标题
 *
 * 核心思路：
 * 1. 先确定“英文标题对应的是哪一个 TMDB 条目”
 * 2. 再从这个确定的条目中读取中文别名
 * 3. 不再使用“搜索结果中第一个中文标题”这种高风险逻辑
 *
 * @param {string} title - 原始标题
 * @param {number|string} season - 季数（可选）
 * @param {number|string} episode - 集数（可选）
 * @returns {Promise<string>} 返回中文标题，失败则返回原标题
 */
export async function getTMDBChineseTitle(title, season = null, episode = null) {
  // -----------------------------
  // 0. 基础检查
  // -----------------------------

  if (!title || typeof title !== 'string') {
    return title;
  }

  const originalInput = title.trim();

  if (!originalInput) {
    return title;
  }

  // 已经包含中文，不需要转换
  if (!isNonChinese(originalInput)) {
    return originalInput;
  }

  // 清理季度等后缀，例如：
  // "The Last of Us Season 2" -> "The Last of Us"
  // "Chainsaw Man S01" -> "Chainsaw Man"
  const cleanTitle = cleanSearchQuery(originalInput).trim();

  if (!cleanTitle) {
    return originalInput;
  }

  if (cleanTitle !== originalInput) {
    log(
      "info",
      `[system] [tmdb] 中文标题转换：清理搜索词 "${originalInput}" -> "${cleanTitle}"`
    );
  }

  // -----------------------------
  // 1. 优先使用 Bangumi Data
  // -----------------------------
  //
  // 注意：
  // 原来的代码直接 localMatches[0]，
  // 这里增加了“精确标题优先”的排序，
  // 避免类似：
  //   Gundam 00
  //   Gundam 0079
  // 这种子串误匹配。
  //

  if (globals.useBangumiData) {
    try {
      const localMatches = await searchBangumiData(
        cleanTitle,
        ['tmdb', 'bangumi', 'anidb']
      );

      if (localMatches && localMatches.length > 0) {

        const normalizeTitle = (value) => {
          if (!value) return "";

          return String(value)
            .toLowerCase()
            .replace(/[\s._\-:：·'’"“”!?！？（）()【】\[\]《》]/g, "")
            .trim();
        };

        const normalizedQuery = normalizeTitle(cleanTitle);

        // 对本地结果进行更严格排序
        const rankedMatches = [...localMatches].sort((a, b) => {

          const scoreMatch = (item) => {
            const titles = Array.isArray(item?.titles)
              ? item.titles.filter(Boolean)
              : [];

            let best = 0;

            for (const t of titles) {
              const normalized = normalizeTitle(t);

              if (!normalized) continue;

              // 完全一致
              if (normalized === normalizedQuery) {
                best = Math.max(best, 100);
                continue;
              }

              // 原标题完全包含查询词
              if (
                normalized.includes(normalizedQuery) ||
                normalizedQuery.includes(normalized)
              ) {
                best = Math.max(best, 70);
                continue;
              }

              // 简单前缀匹配
              if (
                normalized.startsWith(normalizedQuery) ||
                normalizedQuery.startsWith(normalized)
              ) {
                best = Math.max(best, 60);
              }
            }

            return best;
          };

          return scoreMatch(b) - scoreMatch(a);
        });

        const bestMatch = rankedMatches[0];

        if (bestMatch) {

          const titles = Array.isArray(bestMatch.titles)
            ? bestMatch.titles.filter(Boolean)
            : [];

          // 优先寻找真正的中文标题
          const chineseCandidates = titles.filter(
            t => t && !isNonChinese(t)
          );

          if (chineseCandidates.length > 0) {

            // 优先选择：
            // 1. 最常见的短中文标题
            // 2. 避免选择明显的长描述
            const displayTitle =
              chineseCandidates
                .sort((a, b) => {
                  const aLen = String(a).length;
                  const bLen = String(b).length;

                  // 略微偏向较短、较像正式片名的标题
                  if (aLen !== bLen) {
                    return aLen - bLen;
                  }

                  return 0;
                })[0];

            if (displayTitle) {
              log(
                "info",
                `[system] [tmdb] Bangumi Data 精确命中: ${cleanTitle} -> ${displayTitle}`
              );

              return displayTitle;
            }
          }
        }

      }
    } catch (error) {
      log(
        "warn",
        `[system] [tmdb] Bangumi Data 标题转换失败: ${error.message}`
      );
    }
  }

  // -----------------------------
  // 2. 没有 Bangumi Data 命中
  //    使用 TMDB
  // -----------------------------

  if (!globals.tmdbApiKey) {
    log(
      "info",
      `[system] [tmdb] 未配置 TMDB API Key，无法进行英文标题转换: ${cleanTitle}`
    );

    return originalInput;
  }

  try {

    // ---------------------------------
    // 3. 根据是否存在 season 决定搜索类型
    // ---------------------------------

    const isTV = season !== null && season !== undefined;

    const mediaType = isTV ? "tv" : "movie";

    log(
      "info",
      `[system] [tmdb] 开始可靠标题匹配: "${cleanTitle}" (${mediaType})`
    );

    const searchResponse = await searchTmdbTitles(
      cleanTitle,
      mediaType
    );

    if (
      !searchResponse ||
      !searchResponse.data ||
      !Array.isArray(searchResponse.data.results) ||
      searchResponse.data.results.length === 0
    ) {
      log(
        "info",
        `[system] [tmdb] 没有找到英文标题对应的 TMDB 结果: ${cleanTitle}`
      );

      return originalInput;
    }

    const results = searchResponse.data.results;

    // ---------------------------------
    // 4. 标题标准化
    // ---------------------------------

    const normalizeTitle = (value) => {
      if (!value) return "";

      return String(value)
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\s._\-:：·'’"“”!?！？（）()【】《》\[\]]/g, "")
        .trim();
    };

    const normalizedQuery = normalizeTitle(cleanTitle);

    // ---------------------------------
    // 5. 计算 TMDB 搜索结果的匹配分数
    // ---------------------------------

    const calculateScore = (result) => {

      const names = [
        result.name,
        result.title,
        result.original_name,
        result.original_title
      ].filter(Boolean);

      let bestScore = 0;

      for (const name of names) {

        const normalizedName = normalizeTitle(name);

        if (!normalizedName) continue;

        // -----------------------------
        // A. 完全一致 —— 最高优先级
        // -----------------------------

        if (normalizedName === normalizedQuery) {
          bestScore = Math.max(bestScore, 1000);
          continue;
        }

        // -----------------------------
        // B. 完全匹配（忽略标点）
        // -----------------------------

        if (
          normalizedName.replace(/[0-9]/g, "") ===
          normalizedQuery.replace(/[0-9]/g, "")
        ) {
          bestScore = Math.max(bestScore, 900);
          continue;
        }

        // -----------------------------
        // C. 包含关系
        // -----------------------------

        if (
          normalizedName.includes(normalizedQuery) ||
          normalizedQuery.includes(normalizedName)
        ) {

          const shorter = Math.min(
            normalizedName.length,
            normalizedQuery.length
          );

          const longer = Math.max(
            normalizedName.length,
            normalizedQuery.length
          );

          const ratio = shorter / longer;

          bestScore = Math.max(
            bestScore,
            600 + ratio * 200
          );

          continue;
        }

        // -----------------------------
        // D. 简单编辑距离
        // -----------------------------

        const a = normalizedQuery;
        const b = normalizedName;

        const matrix = Array.from(
          { length: a.length + 1 },
          () => new Array(b.length + 1).fill(0)
        );

        for (let i = 0; i <= a.length; i++) {
          matrix[i][0] = i;
        }

        for (let j = 0; j <= b.length; j++) {
          matrix[0][j] = j;
        }

        for (let i = 1; i <= a.length; i++) {

          for (let j = 1; j <= b.length; j++) {

            const cost =
              a[i - 1] === b[j - 1] ? 0 : 1;

            matrix[i][j] = Math.min(
              matrix[i - 1][j] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j - 1] + cost
            );
          }
        }

        const distance = matrix[a.length][b.length];

        const maxLength = Math.max(
          a.length,
          b.length
        );

        if (maxLength > 0) {

          const similarity =
            1 - distance / maxLength;

          bestScore = Math.max(
            bestScore,
            similarity * 500
          );
        }
      }

      // ---------------------------------
      // 6. 年份辅助判断
      // ---------------------------------

      const releaseDate =
        result.first_air_date ||
        result.release_date ||
        "";

      const yearMatch =
        cleanTitle.match(/\b(19|20)\d{2}\b/);

      if (yearMatch && releaseDate) {

        const queryYear = parseInt(
          yearMatch[0],
          10
        );

        const resultYear = parseInt(
          releaseDate.substring(0, 4),
          10
        );

        if (
          queryYear === resultYear
        ) {
          bestScore += 150;
        }
      }

      // ---------------------------------
      // 7. 人气作为非常弱的辅助因素
      // ---------------------------------

      if (result.popularity) {

        const popularityBonus =
          Math.min(
            Math.log10(
              Math.max(result.popularity, 1)
            ) * 5,
            25
          );

        bestScore += popularityBonus;
      }

      return bestScore;
    };

    // ---------------------------------
    // 8. 对所有候选进行评分
    // ---------------------------------

    const rankedResults = results
      .map(result => ({
        result,
        score: calculateScore(result)
      }))
      .sort((a, b) => b.score - a.score);

    // ---------------------------------
    // 9. 取最佳匹配
    // ---------------------------------

    const best = rankedResults[0];

    if (!best || !best.result) {

      log(
        "info",
        `[system] [tmdb] 无法确定 "${cleanTitle}" 对应的作品`
      );

      return originalInput;
    }

    const selectedResult = best.result;

    const selectedTitle =
      selectedResult.name ||
      selectedResult.title ||
      "";

    const selectedOriginalTitle =
      selectedResult.original_name ||
      selectedResult.original_title ||
      "";

    log(
      "info",
      `[system] [tmdb] 最佳作品候选: "${selectedTitle}" / 原名: "${selectedOriginalTitle}" / 得分: ${best.score.toFixed(2)}`
    );

    // ---------------------------------
    // 10. 安全检查
    // ---------------------------------

    //
    // 如果完全没有任何可靠的标题命中，
    // 不要因为“第一个搜索结果”就强行转换。
    //

    if (best.score < 500) {

      log(
        "info",
        `[system] [tmdb] "${cleanTitle}" 没有达到可靠匹配阈值，拒绝强制转换`
      );

      return originalInput;
    }

    // ---------------------------------
    // 11. 获取该作品自己的中文别名
    // ---------------------------------

    const resultMediaType =
      selectedResult.media_type ||
      mediaType;

    let alternativeResponse = null;

    try {

      alternativeResponse =
        await getTmdbAlternativeTitles(
          resultMediaType,
          selectedResult.id
        );

    } catch (error) {

      log(
        "warn",
        `[system] [tmdb] 获取作品中文别名失败: ${error.message}`
      );
    }

    if (
      alternativeResponse &&
      alternativeResponse.data
    ) {

      const titles =
        alternativeResponse.data.results ||
        alternativeResponse.data.titles ||
        [];

      if (Array.isArray(titles)) {

        // ---------------------------------
        // 12. 中文别名优先级
        //
        // CN > TW > HK > SG > 其他中文
        // ---------------------------------

        const chineseTitles =
          titles.filter(item => {

            const value =
              item?.title ||
              item?.name ||
              "";

            return (
              value &&
              !isNonChinese(value)
            );
          });

        if (chineseTitles.length > 0) {

          const regionPriority = {
            CN: 100,
            TW: 90,
            HK: 80,
            SG: 70
          };

          chineseTitles.sort((a, b) => {

            const aRegion =
              a.iso_3166_1 ||
              a.iso_639_1 ||
              "";

            const bRegion =
              b.iso_3166_1 ||
              b.iso_639_1 ||
              "";

            const aPriority =
              regionPriority[aRegion] || 10;

            const bPriority =
              regionPriority[bRegion] || 10;

            if (
              aPriority !== bPriority
            ) {
              return bPriority - aPriority;
            }

            const aTitle =
              a.title ||
              a.name ||
              "";

            const bTitle =
              b.title ||
              b.name ||
              "";

            return (
              aTitle.length -
              bTitle.length
            );
          });

          const chineseTitle =
            chineseTitles[0]?.title ||
            chineseTitles[0]?.name;

          if (chineseTitle) {

            log(
              "info",
              `[system] [tmdb] 英文标题可靠转换: "${cleanTitle}" -> "${chineseTitle}" (作品: "${selectedTitle}")`
            );

            return chineseTitle;
          }
        }
      }
    }

    // ---------------------------------
    // 13. 如果没有 alternative_titles
    //    使用 TMDB search 返回的中文标题
    // ---------------------------------

    const tmdbChineseTitle =
      selectedResult.name ||
      selectedResult.title ||
      "";

    if (
      tmdbChineseTitle &&
      !isNonChinese(tmdbChineseTitle)
    ) {

      log(
        "info",
        `[system] [tmdb] 使用 TMDB 条目自身中文标题: "${cleanTitle}" -> "${tmdbChineseTitle}"`
      );

      return tmdbChineseTitle;
    }

    // ---------------------------------
    // 14. 最终安全兜底
    // ---------------------------------

    log(
      "info",
      `[system] [tmdb] 找不到可靠中文标题，保留原标题: "${originalInput}"`
    );

    return originalInput;

  } catch (error) {

    log(
      "error",
      `[system] [tmdb] 中文标题转换失败: ${error.message}`
    );

    return originalInput;
  }
}

// =====================
// 智能标题替换相关函数
// =====================

// 识别季度、剧场版、外传、副标题等后缀信息的正则白名单
const SUFFIX_PATTERN = /(?:\s+|^)(?:第?\s*(?:\d+|[一二三四五六七八九十]+)\s*[季期部]|season\s*\d+|s\d+|part\s*\d+|act\s*\d+|phase\s*\d+|the\s+final\s+season|(?:movie|film|ova|oad|sp|剧场版|劇場版|续[篇集]|外传)(?![a-z]))|[:：~～]|\s+.*?篇|(?<=\s|^)\d+$/i

const SEPARATOR_REGEX = /[ :：~～]/;

/**
 * 寻找标题中属于后缀或季度信息的起始位置
 * @param {string} title 原标题
 * @returns {number} 后缀起始索引
 */
function detectSuffixStart(title) {
  const match = title.match(SUFFIX_PATTERN);
  return match ? match.index : title.length;
}

/**
 * 利用后缀正则清洗搜索关键词，移除季度等信息以提高 TMDB 搜索命中率
 * @param {string} title 原始标题
 * @returns {string} 清洗后的标题主体
 */
export function cleanSearchQuery(title) {
  const limit = detectSuffixStart(title);
  if (limit < title.length) {
    return title.substring(0, limit).trim();
  }
  return title;
}

/**
 * 根据 TMDB 中文别名对番剧列表进行智能标题替换
 * @param {Array} animes 待处理的 anime 对象列表
 * @param {string} cnAlias TMDB 中文别名
 */
export function smartTitleReplace(animes, cnAlias) {
  if (!animes || animes.length === 0 || !cnAlias) return;

  let validCount = 0;
  // 遍历列表执行属性兜底赋值，并统计实际需要执行标题替换的有效条目数
  for (const anime of animes) {
    anime._displayTitle = anime._displayTitle || anime.title || "";
    if (!(anime.isLocalPriority || anime._displayTitle.includes(cnAlias))) {
      validCount++;
    }
  }

  // 若有效替换条目数为0，说明均已处理或无需处理，直接静默退出
  if (validCount === 0) return;

  log("info", `[system] [tmdb] 启动智能替换，目标别名: "${cnAlias}"，待处理条目: ${validCount}`);

  // 计算所有标题主体部分的 LCP (最长公共前缀)
  const baseTitles = animes.map(a => {
    const t = a.org_title || a.title || "";
    return t.substring(0, detectSuffixStart(t));
  });

  let lcp = "";
  if (baseTitles.length > 0) {
    const sorted = baseTitles.concat().sort();
    const a1 = sorted[0], a2 = sorted[sorted.length - 1];
    let i = 0;
    while (i < a1.length && a1.charAt(i) === a2.charAt(i)) i++;
    lcp = a1.substring(0, i);
  }

  if (lcp && lcp.length > 1) {
    log("info", `[system] [tmdb] 计算出最长公共前缀 (LCP): "${lcp}"`);
  }

  // 执行具体的智能替换策略
  for (const anime of animes) {
    const originalTitle = anime.title || "";

    // 过滤已被本地数据处理或已含目标别名的条目
    if (anime.isLocalPriority || originalTitle.includes(cnAlias)) continue;

    // 策略 A: LCP 模式
    if (lcp && lcp.length > 1 && originalTitle.startsWith(lcp)) {
      const suffix = originalTitle.substring(lcp.length).trim();
      anime._displayTitle = suffix ? `${cnAlias}${suffix.match(/^[~～:：]/) ? '' : ' '}${suffix}` : cnAlias;
      log("info", `[system] [tmdb] [LCP模式] "${originalTitle}" -> "${anime._displayTitle}"`);
    } else {
      const match = originalTitle.match(SEPARATOR_REGEX);
      if (match) {
        const prefix = originalTitle.substring(0, match.index).trim();
        const suffix = originalTitle.substring(match.index);
        // 策略 B1: 前缀保护模式（防止截断季数等特征前缀）
        if (prefix && SUFFIX_PATTERN.test(prefix)) {
          const subMatch = suffix.trim().match(SEPARATOR_REGEX);
          const subSuffix = subMatch ? suffix.trim().substring(subMatch.index) : '';
          anime._displayTitle = `${prefix} ${cnAlias}${subSuffix}`;
          log("info", `[system] [tmdb] [前缀保护模式] "${originalTitle}" -> "${anime._displayTitle}"`);
        } else {
          // 策略 B2: 常规分隔符模式
          anime._displayTitle = cnAlias + suffix;
          log("info", `[system] [tmdb] [分隔符模式] "${originalTitle}" -> "${anime._displayTitle}"`);
        }
      } else {
        // 策略 C: 安全兜底模式
        if (isNonChinese(originalTitle)) {
          anime._displayTitle = cnAlias;
          log("info", `[system] [tmdb] [纯外文全替模式] "${originalTitle}" -> "${anime._displayTitle}"`);
        } else {
          log("info", `[system] [tmdb] [跳过替换] "${originalTitle}" 含有中文且特征不符，拒绝强制全替以防误杀`);
        }
      }
    }
  }
}

// =====================
// TMDB 季边界映射
// =====================

/**
 * 将 bangumi-data 的 TMDB 扁平检索结果转换为跨季边界序列.
 * 每个 matchedSiteKey 为 'tmdb' 的结果, 其 siteId 形如 "tv/{id}" 或
 * "tv/{id}/season/N/episode/{M}", M 为该条目在 TMDB 绝对编号中的起始集数;
 * 收集同一 tv/{id} 下各条目起始集数即可推算跨季映射边界
 * @param {Array<Object>} matches searchBangumiData 返回的扁平结果数组
 * @returns {Array<{order:number, startEpisode:number, title:string, tmdbId:string}>|null}
 */
export function buildTmdbSeasonBoundaries(matches) {
  const baseMaps = new Map();

  for (const m of matches) {
    if (!m || m.matchedSiteKey !== 'tmdb' || !m.siteId) continue;

    const epMatch = m.siteId.match(/^(tv\/\d+)(?:\/season\/\d+\/episode\/(\d+))?$/);
    if (!epMatch) continue;

    const baseId = epMatch[1];
    const startEp = epMatch[2] ? parseInt(epMatch[2], 10) : 1;

    const entry = { order: 0, startEpisode: startEp, title: m.title || '', tmdbId: baseId };
    if (!baseMaps.has(baseId)) {
      baseMaps.set(baseId, [entry]);
    } else {
      baseMaps.get(baseId).push(entry);
    }
  }

  if (baseMaps.size === 0) return null;

  const best = [...baseMaps.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0];

  if (best[1].length < 2) return null;

  best[1].sort((a, b) => a.startEpisode - b.startEpisode);
  for (let i = 0; i < best[1].length; i++) {
    best[1][i].order = i + 1;
  }
  return best[1];
}

/**
 * 依据番剧标题从 bangumi-data 推导 TMDB 跨季边界, 用于在目标集不在首季时跳过无关季号
 * @param {string} title 检索标题 (直接传给 searchBangumiData, 内部已做季剥离处理)
 * @param {(title: string, siteKeys: string[]) => Promise<Array<Object>>} [searchFn]
 * @returns {Promise<Array<{order:number, startEpisode:number, title:string, tmdbId:string}>|null>}
 */
export async function getTmdbSeasonBoundaries(title, searchFn = searchBangumiData) {
  if (!globals.useBangumiData) return null;

  try {
    const matches = await searchFn(title, ['tmdb']);
    return buildTmdbSeasonBoundaries(matches);
  } catch (e) {
    log('warn', `[system] [tmdb] Bangumi-Data 本地获取TMDB季边界失败: ${e.message}（检索词：${title}）`);
    return null;
  }
}
