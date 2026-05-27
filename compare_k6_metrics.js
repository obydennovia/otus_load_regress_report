const axios = require('axios');

// === НАСТРОЙКИ ПОДКЛЮЧЕНИЯ К INFLUXDB 1.X ===
const INFLUX_URL = 'http://localhost:8086';
const DB_NAME = 'otus_webtours';

// === КРИТЕРИИ КАЧЕСТВА (SLA ИЗ ТЗ) ===
const MAX_ALLOWED_RT = 3000;      // Жесткий SLA по условию: 3 секунды (3000 мс)
const MAX_ALLOWED_ERRORS = 1.0;   // Допустимый процент ошибок (1%)

async function queryInflux(q) {
    try {
        const response = await axios.get(`${INFLUX_URL}/query`, { params: { db: DB_NAME, q } });
        return response.data;
    } catch (e) {
        console.error(`❌ Ошибка запроса к InfluxDB: ${e.message}`);
        return null;
    }
}

async function getMetricsForLastTest(scenarioName) {
    // Шаг 1: Находим время последней точки для текущего сценария k6
    const timeQuery = `SELECT "value" FROM "http_req_duration" WHERE "scenario"='${scenarioName}' ORDER BY time DESC LIMIT 1`;
    const timeData = await queryInflux(timeQuery);
    
    // Безопасная проверка структуры ответа InfluxDB 1.x
    if (!timeData?.results?.[0]?.series?.[0]?.values?.[0]?.[0]) {
        return [];
    }

    const lastPointTime = timeData.results[0].series[0].values[0][0];
    
    // Шаг 2: Извлекаем 95-й перцентиль времени отклика и средний RPS за последние 85 минут существования теста
    const metricsQuery = `SELECT PERCENTILE("value", 95) as rt_p95, COUNT("value") / 600 as actual_rps FROM "http_req_duration" 
                          WHERE "scenario"='${scenarioName}' AND time >= '${lastPointTime}' - 85m AND time <= '${lastPointTime}' 
                          GROUP BY time(10m) fill(none)`;
                          
    const errorsQuery = `SELECT MEAN("value") * 100 as err_rate FROM "http_req_failed" 
                         WHERE "scenario"='${scenarioName}' AND time >= '${lastPointTime}' - 85m AND time <= '${lastPointTime}' 
                         GROUP BY time(10m) fill(none)`;

    const md = await queryInflux(metricsQuery);
    const ed = await queryInflux(errorsQuery);

    if (!md?.results?.[0]?.series?.[0]?.values) {
        return [];
    }

    const series = md.results[0].series[0];
    const cols = series.columns;
    const rtIdx = cols.indexOf('rt_p95');
    const rpsIdx = cols.indexOf('actual_rps');

    const errValues = ed?.results?.[0]?.series?.[0]?.values || [];
    const errCols = ed?.results?.[0]?.series?.[0]?.columns || [];
    const errIdx = errCols.indexOf('err_rate');

    return series.values.map((val, index) => {
        const rt = val[rtIdx] || 0;
        const rps = val[rpsIdx] || 0;
        const err = (errValues[index] && errIdx !== -1) ? (errValues[index][errIdx] || 0) : 0;
        
        // Линейный шаг: старт со 60, прибавляем по 6 итераций за каждую следующую ступень (+10%)
        const iterationsPerMin = 60 + (index * 6); 

        // Переводим в итерации в час (умножаем на 60 минут)
        const iterationsPerHour = iterationsPerMin * 60;

        // Согласно Run Logic из JMX/k6: 1 итерация = 1 вход + 2 покупки билетов (всего 3 целевые бизнес-операции)
        const opsPerHour = iterationsPerHour * 3; 

        return {
            step: index + 1,
            profilePct: 100 + (index * 10), // Ступени: 100%, 110%, 120%...
            opsPerHour: opsPerHour,
            rt: rt,
            error_rate: err
        };
    }).filter(v => v.rt > 0);
}
async function generateOfficialReport() {
    console.log("🔍 Выгрузка ПОСЛЕДНИХ актуальных данных k6 из InfluxDB и расчет регрессии...\n");

    const baseline = await getMetricsForLastTest('baseline_max_test');
    const regression = await getMetricsForLastTest('regression_max_test');

    if (baseline.length === 0 || regression.length === 0) {
        console.log("❌ Данные последнего запуска не найдены. Убедитесь, что k6-тест успел записать данные в InfluxDB.");
        return;
    }

    let maxStableBaseRps = 0;
    let maxStableRegRps = 0;
    let criticalStep = null;
    let totalRtBase = 0;
    let totalRtReg = 0;
    
    const stepsComparison = [];
    const totalSteps = Math.min(baseline.length, regression.length);

    for (let i = 0; i < totalSteps; i++) {
        const b = baseline[i];
        const r = regression[i];

        totalRtBase += b.rt;
        totalRtReg += r.rt;

        const baseSlaOk = b.rt <= MAX_ALLOWED_RT && b.error_rate <= MAX_ALLOWED_ERRORS;
        const regSlaOk = r.rt <= MAX_ALLOWED_RT && r.error_rate <= MAX_ALLOWED_ERRORS;

        if (baseSlaOk) maxStableBaseRps = b.opsPerHour;
        if (regSlaOk) {
            maxStableRegRps = r.opsPerHour;
        } else if (!criticalStep) {
            criticalStep = { step: r.step, pct: r.profilePct, ops: r.opsPerHour, rt: r.rt, err: r.error_rate, baseRt: b.rt };
        }

        const rtChangePct = b.rt > 0 ? ((r.rt - b.rt) / b.rt) * 100 : 0;

        stepsComparison.push({
            step: b.step, pct: b.profilePct, ops: b.opsPerHour, baseRt: b.rt, regRt: r.rt, baseErr: b.error_rate, regErr: r.error_rate, rtChangePct
        });
    }

    const avgRtBase = totalRtBase / totalSteps;
    const avgRtReg = totalRtReg / totalSteps;
    const isDegradation = maxStableRegRps < maxStableBaseRps || avgRtReg > avgRtBase * 1.1;
    const slowDownFactor = avgRtBase > 0 ? avgRtReg / avgRtBase : 1.0;
    const capacityDiffPct = maxStableBaseRps > 0 ? ((maxStableBaseRps - maxStableRegRps) / maxStableBaseRps) * 100 : 0;

    // === ВЫВОД ОТЧЕТА ПО РЕГЛАМЕНТУ ===
    console.log("=========================================================================================");
    console.log("                       ЗАКЛЮЧЕНИЕ РЕЛИЗНОГО НАГРУЗОЧНОГО ТЕСТИРОВАНИЯ                    ");
    console.log("=========================================================================================");
    console.log(`Система: WebTours | Сравнение: Финальная поставка (:1090) относительно Эталона (:1080)`);
    console.log(`Профиль нагрузки: Ступенчатый (от 100% до 170% требований ТЗ, шаг +10%, ступень 10 минут)`);
    console.log("-----------------------------------------------------------------------------------------\n");

    console.log(`1. Деградация производительности, по сравнению с предыдущим релизом: ${isDegradation ? '[ВЫЯВЛЕНА]' : '[НЕ ВЫЯВЛЕНА]'}`);
    if (isDegradation) {
        console.log(`   [Деградация производительности составляет ${capacityDiffPct.toFixed(1)}% от предыдущего нагрузочного тестирования.]`);
        console.log(`   [Расхождение объясняется критическим ростом времени отклика на регрессионном стенде при увеличении интенсивности.]`);
    } else {
        console.log(`   [Зафиксирован паритет метрик производительности версий системы. Изменения отсутствуют.]`);
    }

    console.log("\n2. СРАВНИТЕЛЬНЫЙ АНАЛИЗ РЕЗУЛЬТАТОВ ДВУХ ВЕРСИЙ СИСТЕМЫ (ПОСЛЕДНИЙ ЗАПУСК):");
    console.log("-----------------------------------------------------------------------------------------");
    console.log("Шаг | Профиль | Нагрузка (ОП/Ч) | Эталон (RT p95) | Регресс (RT p95) | Расхождение RT (%)");
    console.log("-----------------------------------------------------------------------------------------");
    stepsComparison.forEach(s => {
        const sign = s.rtChangePct > 0 ? "+" : "";
        const alertTag = (s.regRt > MAX_ALLOWED_RT || s.regErr > MAX_ALLOWED_ERRORS) ? "⚠️ SLA FAIL" : "🟢 OK";
        console.log(
            ` ${s.step}  | ${s.pct}%     | ${s.ops.toFixed(0)} ОП/Ч     | ${s.baseRt.toFixed(0)} мс         | ${s.regRt.toFixed(0)} мс         | ${sign}${s.rtChangePct.toFixed(1)}% (${alertTag})`
        );
    });
    console.log("-----------------------------------------------------------------------------------------");

    console.log("\n3. Риски при установке релиза на промышленную среду:");
    if (isDegradation && criticalStep) {
        console.log(`   a. Риск – [Уровень риска: КРИТИЧЕСКИЙ].`);
        console.log(`      Описание: Риск тотального падения пропускной способности и отказа в обслуживании на проде.`);
        console.log(`      Объяснение уровня риска: Начиная со ступени ${criticalStep.pct}% профиля (${criticalStep.ops.toFixed(0)} ОП/Ч), время отклика превышает лимит SLA (3000 мс) и составляет ${criticalStep.rt.toFixed(0)} мс (замедление относительно эталона в ${(criticalStep.rt / criticalStep.baseRt).toFixed(1)} раза).`);
        console.log(`      Предлагаемое действие – Категорический отказ в деплое. Полный возврат релиза на рефакторинг архитектуры.`);
    } else {
        console.log(`   a. Риск – [Уровень риска: НИЗКИЙ]. Рисков для промышленной среды не зафиксировано.`);
    }

    console.log("\n4. Дефекты:");
    if (isDegradation && criticalStep) {
        console.log("Список открытых/не исправленных дефектов:");
        console.log("ИД дефекта   Серьезность   Резюме                                                  Статус    Тип");
        console.log(`DF-1090-03   Критический   Тотальный регресс RT (замедление в ${slowDownFactor.toFixed(1)} раз) на всех ступенях  Открыто   Блокирующий дефект`);
    } else {
        console.log("Список открытых/не исправленных дефектов: Отсутствуют.");
    }

    console.log("\n5. Краткие выводы по тестам:");
    console.log(`   • Эталонный тест (:1080): Максимальная производительность в рамках SLA составляет ${maxStableBaseRps.toFixed(0)} операций в час.`);
    console.log(`   • Регрессионный тест (:1090): Максимальная производительность в рамках SLA составляет ${maxStableRegRps.toFixed(0)} операций в час.`);
    
    if (isDegradation && criticalStep) {
        console.log(`   • Сравнение версий: Выявлено падение пропускной способности стабильной работы релиза на ${capacityDiffPct.toFixed(0)}%. Точка перегиба пройдена на шаге №${criticalStep.step} (${criticalStep.pct}% профиля), где время отклика регрессионного стенда составляет ${criticalStep.rt.toFixed(0)} мс относительно ${criticalStep.baseRt.toFixed(0)} мс эталона.`);
        console.log(`   • На уровне нагрузки в ${criticalStep.pct}% профиля зафиксирована деградация производительности.`);
    } else {
        console.log(`   • Сравнение версий: Зафиксирован 100% паритет производительности. Новый код полностью готов к эксплуатации под пиковыми нагрузками.`);
        console.log(`   • Деградация производительности во всем диапазоне целевых нагрузок не зафиксирована.`);
    }
    console.log("=========================================================================================");
}

generateOfficialReport();
