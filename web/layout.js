/**
 * 课表排版计算（纯函数，不碰 DOM，方便在 Node 里做断言测试）。
 *
 * 目标：让色块占的格子数与**实际上课的节次**一致。
 * 比如「实用数值分析 6-7-8 节」应该占满 6-7 节那一格，再占 8-9 节那一格的上半部分。
 *
 * 做法：把网格行从「大节」换成「小节」——每小节一行，等高等分；
 * 每门课用 grid-row: 起始节 / span 节数 定位，左侧大节标签则跨若干小节行。
 */

/** 这门课在第 week 周是否要上。 */
export function isActive(course, week) {
  const spans = course.weeks || [];
  if (!spans.length) return true;
  for (const [from, to] of spans) {
    if (week < from || week > to) continue;
    if (course.parity === '单' && week % 2 === 0) continue;
    if (course.parity === '双' && week % 2 === 1) continue;
    return true;
  }
  return false;
}

/** 课程实际占用的节次区间。合并单元格必然是连续的，这里再兜一层底。 */
export function sectionRange(course) {
  const list = (course.sections || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return null;
  const start = list[0];
  const end = list[list.length - 1];
  return { start, end, span: end - start + 1 };
}

/**
 * 同一天里时间重叠的课自动并排（各占 1/n 宽），只有真重叠时才触发。
 * 现在 18 门课没有任何重叠，这是为以后加课留的保险。
 */
function assignLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.span - b.span);
  const groups = [];
  let current = null;
  for (const item of sorted) {
    if (current && item.start <= current.end) {
      current.items.push(item);
      current.end = Math.max(current.end, item.end);
    } else {
      current = { items: [item], end: item.end };
      groups.push(current);
    }
  }
  for (const group of groups) {
    const laneEnds = [];
    for (const item of group.items) {
      let lane = laneEnds.findIndex((end) => end < item.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      item.lane = lane;
    }
    for (const item of group.items) item.lanes = laneEnds.length;
  }
  return sorted;
}

/**
 * 算出某一周要怎么画。
 *
 * @returns {{
 *   maxSection: number,
 *   periodBlocks: Array<{index:number,name:string,time:string,sections:number[],first:number,span:number}>,
 *   items: Array<{course:object,day:number,start:number,end:number,span:number,lane:number,lanes:number}>,
 *   hasCoursesThisWeek: boolean,
 *   firstWeekWithCourses: number|null,
 *   nextWeekWithCourses: number|null,
 *   emptyMessage: string
 * }}
 */
export function layoutWeek(schedule, week) {
  const periods = [...(schedule.periods || [])].sort((a, b) => a.index - b.index);
  const courses = schedule.courses || [];

  let maxSection = 0;
  for (const period of periods) for (const s of period.sections || []) maxSection = Math.max(maxSection, s);
  for (const course of courses) for (const s of course.sections || []) maxSection = Math.max(maxSection, s);
  if (!maxSection) maxSection = 12;

  const periodBlocks = periods.map((period) => {
    const secs = (period.sections || []).slice().sort((a, b) => a - b);
    return {
      index: period.index,
      name: period.name,
      time: period.time || '',
      sections: secs,
      first: secs[0] || 1,
      span: Math.max(secs.length, 1),
    };
  });

  // 只保留本周要上的课：不在本周的直接不画，重叠问题也就自然消失了
  const items = [];
  const byDay = new Map();
  for (const course of courses) {
    const range = sectionRange(course);
    if (!range || !isActive(course, week)) continue;
    const item = {
      course, day: course.day,
      start: range.start, end: range.end, span: range.span,
      lane: 0, lanes: 1,
    };
    items.push(item);
    if (!byDay.has(course.day)) byDay.set(course.day, []);
    byDay.get(course.day).push(item);
  }
  for (const list of byDay.values()) assignLanes(list);
  items.sort((a, b) => a.day - b.day || a.start - b.start);

  // 整周没课时，给一句人话提示，避免让人以为界面坏了
  const weeksWithCourses = new Set();
  for (const course of courses) {
    for (const [from, to] of course.weeks || []) {
      for (let w = from; w <= to; w += 1) weeksWithCourses.add(w);
    }
  }
  const ordered = [...weeksWithCourses].sort((a, b) => a - b);
  const firstWeekWithCourses = ordered.length ? ordered[0] : null;
  const nextWeekWithCourses = ordered.find((w) => w > week) ?? null;

  let emptyMessage = '';
  if (!items.length) {
    if (firstWeekWithCourses !== null && week < firstWeekWithCourses) {
      emptyMessage = `本周没有课，课程从第 ${firstWeekWithCourses} 周开始`;
    } else if (nextWeekWithCourses !== null) {
      emptyMessage = `本周没有课，下一门课在第 ${nextWeekWithCourses} 周`;
    } else {
      emptyMessage = '本周没有课，本学期的课已经上完了';
    }
  }

  return {
    maxSection,
    periodBlocks,
    items,
    hasCoursesThisWeek: items.length > 0,
    firstWeekWithCourses,
    nextWeekWithCourses,
    emptyMessage,
  };
}
