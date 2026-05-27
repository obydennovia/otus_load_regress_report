import http from 'k6/http';
import { check, group } from 'k6';
import { SharedArray } from 'k6/data';

// --- НАСТРОЙКИ СТЕНДОВ И SLA ---
const URL_1080 = 'http://webtours.load-test.ru:1080';
const URL_1090 = 'http://webtours.load-test.ru:1090';

export const options = {
    thresholds: {
        'http_req_duration': ['p(95)<3000'], // Жесткий SLA по условию (3 секунды)
    },
    scenarios: {
        // Сценарий для эталонного сайта 1080
        baseline_max_test: {
            executor: 'ramping-arrival-rate',
            exec: 'runBaseline',
            preAllocatedVUs: 40,  
            maxVUs: 200,          
            timeUnit: '1m', 
            startRate: 60,        // 100% нового профиля = 60 итераций в минуту (180 оп/мин)
            stages: [
                { target: 60,  duration: '10m' }, // Ступень 1: 100% профиля (60 итер/мин)
                { target: 66,  duration: '0s'  }, // Шаг 2: +10% профиля (66 итер/мин)
                { target: 66,  duration: '10m' }, 
                { target: 72,  duration: '0s'  }, // Шаг 3: +20% профиля (72 итер/мин)
                { target: 72,  duration: '10m' },
                { target: 78,  duration: '0s'  }, // Шаг 4: +30% профиля (78 итер/мин)
                { target: 78,  duration: '10m' },
                { target: 84,  duration: '0s'  }, // Шаг 5: +40% профиля (84 итер/мин)
                { target: 84,  duration: '10m' },
                { target: 90,  duration: '0s'  }, // Шаг 6: +50% профиля (90 итер/мин)
                { target: 90,  duration: '10m' },
                { target: 96,  duration: '0s'  }, // Шаг 7: +60% профиля (96 итер/мин)
                { target: 96,  duration: '10m' },
                { target: 0,   duration: '0s'  }, // Мгновенный сброс в ноль
            ],
        },
        // Сценарий для регрессионного сайта 1090
        regression_max_test: {
            executor: 'ramping-arrival-rate',
            exec: 'runRegression',
            preAllocatedVUs: 40,
            maxVUs: 200,
            timeUnit: '1m',
            startRate: 60,
            stages: [
                { target: 60,  duration: '10m' },
                { target: 66,  duration: '0s'  },
                { target: 66,  duration: '10m' },
                { target: 72,  duration: '0s'  },
                { target: 72,  duration: '10m' },
                { target: 78,  duration: '0s'  },
                { target: 78,  duration: '10m' },
                { target: 84,  duration: '0s'  },
                { target: 84,  duration: '10m' },
                { target: 90,  duration: '0s'  },
                { target: 90,  duration: '10m' },
                { target: 96,  duration: '0s'  },
                { target: 96,  duration: '10m' },
                { target: 0,   duration: '0s'  },
            ],
        },
    },
};

// Общие заголовки для всего скрипта из файла
const globalHeaders = {
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    'Priority': 'u=4',
    'Accept-Encoding': 'gzip, deflate',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const baseHeaders = {
    headers: globalHeaders,
};

// Query-параметры из файла
const queryParams = {
    numPassengers: "1",
    firstName: "Ivan",
    lastName: "Obydennov",
    address1: "Street",
    address2: "City",
    pass1: "Ivan Obydennov",
    creditCard: "1234",
    expDate: "12/3000"
};

// Очистка Cookie
export function clearCookiesAction(BASE_URL) {
    const jar = http.cookieJar();
    jar.clear(BASE_URL);
}

// Извлечение логина и пароля из файла webtours_users.json
const credentials = new SharedArray('Get data JSON', function(){
    const file = JSON.parse(open('./webtours_users.json'));
    return file.users;
});

// --- ИСПОЛНИТЕЛЬНЫЕ МАРШРУТИЗАТОРЫ ДЛЯ СЦЕНАРИЕВ ---
export function runBaseline() {
    executeWorkflow(URL_1080);
}

export function runRegression() {
    executeWorkflow(URL_1090);
}

// --- ЕДИНЫЙ ЦЕНТРАЛЬНЫЙ КОНТРОЛЛЕР RUN LOGIC (ПРОПОРЦИЯ 1:2) ---
function executeWorkflow(BASE_URL) {
    clearCookiesAction(BASE_URL);

    // 1. Получение userSession с RootPage (1 раз)
    const userSession = rootPageTransaction(BASE_URL);
    if (!userSession) return;

    // 2. Выбор рандомного пользователя и авторизация (1 раз)
    const randomUser = credentials[Math.floor(Math.random() * credentials.length)];
    loginTransaction(BASE_URL, userSession, randomUser.username, randomUser.password);

    // 3. ПЕРВАЯ ПОКУПКА БИЛЕТА (Блок Run Покупка 1)
    const flightData1 = flightTransaction(BASE_URL);
    if (flightData1 && flightData1.cityList.length > 0) {
        oneWayTicketTransaction(BASE_URL, flightData1);
    }

    // 4. ВТОРАЯ ПОКУПКА БИЛЕТА (Блок Run Покупка 2)
    const flightData2 = flightTransaction(BASE_URL);
    if (flightData2 && flightData2.cityList.length > 0) {
        oneWayTicketTransaction(BASE_URL, flightData2);
    }

    // 5. Возвращение на RootPage в конце итерации
    rootPageTransaction(BASE_URL);
}

// Вспомогательная функция для выбора случайного элемента
const getRandomElement = (arr) => {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
};
/* ---------------------------------------------- */
/* --- Begin Root Page Transaction Controller --- */
/* ---------------------------------------------- */
export function rootPageTransaction(BASE_URL) {
    let userSession = null;
    group('01_Root_Page_Transaction', () => {
        let mainPage = http.get(`${BASE_URL}/webtours/`, { headers: baseHeaders });
        check(mainPage, { 'main page status is 200': (r) => r.status === 200 });

        const enterHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/webtours/`
        });
        let enterRootPage = http.get(`${BASE_URL}/cgi-bin/welcome.pl?signOff=true`, { 
            headers: enterHeaders 
        });
        check(enterRootPage, { 
            'welcome.pl status is 200': (r) => r.status === 200
        });

        const navHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/welcome.pl?signOff=true`
        });
        let navPage = http.get(`${BASE_URL}/cgi-bin/nav.pl?in=home`, { 
            headers: navHeaders 
        });
        const isNavOk = check(navPage, { 
            'nav.pl status is 200': (r) => r.status === 200
        });

        if (isNavOk) {
            const match = navPage.body.match(/name="userSession"\s+value="([^"]+)"/) 
                || navPage.body.match(/value="([^"]+)"\s+name="userSession"/);
            if (match && match[1]) {
                userSession = match[1];
                console.log(`userSession найден: ${userSession}`);
            } else {
                console.error('userSession не найден');
            }
        }
    });
    return userSession;
}

/* ------------------------------------------ */
/* --- Begin Login Transaction Controller --- */
/* ------------------------------------------ */
export function loginTransaction(BASE_URL, userSession, username, password) {
    group('02_Login_Transaction', () => {
        if (!userSession || !username || !password) {
            console.error(`Login failed: userSession=${userSession}, username=${username}, password=${password}`);
            return;
        }

        const loginHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/nav.pl?in=home`,
            'Origin': BASE_URL,
            'Upgrade-Insecure-Requests': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        });
        const formData = {
            'userSession': userSession,
            'username': username,
            'password': password,
            'login.x': '74',
            'login.y': '4',
            'JSFormSubmit': 'off',
        };
        let beginAuthorization = http.post(`${BASE_URL}/cgi-bin/login.pl?in=home`, formData, {
            headers: loginHeaders
        });
        check(beginAuthorization, {
            'login.pl POST status is 200': (r) => r.status === 200
        });

        const checkHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/login.pl`
        });
        let checkAuthorization = http.get(`${BASE_URL}/cgi-bin/nav.pl?page=menu&in=home`, {
            headers: checkHeaders
        });
        check(checkAuthorization, {
            'nav.pl GET status is 200': (r) => r.status === 200
        });

        const endHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/login.pl`
        });
        let endAuthorization = http.get(`${BASE_URL}/cgi-bin/login.pl?intro=true`, {
            headers: endHeaders
        });
        check(endAuthorization, {
            'login.pl GET status is 200': (r) => r.status === 200
        });
    });
}

/* -------------------------------------------- */
/* --- Begin Flight Transaction Controller --- */
/* -------------------------------------------- */
export function flightTransaction(BASE_URL) {
    let flightData = {
        cityList: [],
        departDate: null,
        returnDate: null
    };
    group('03_Flight_Transaction', () => {
        const flightPageHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/nav.pl?page=menu&in=flights`
        });
        let getFlightPage = http.get(`${BASE_URL}/cgi-bin/welcome.pl?page=search`, {
            headers: flightPageHeaders
        });
        check(getFlightPage, {
            'welcome.pl?page=search status is 200': (r) => r.status === 200
        });

        const searchHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/welcome.pl?page=search`
        });
        let searchFlightPage = http.get(`${BASE_URL}/cgi-bin/nav.pl?page=menu&in=flights`, {
            headers: searchHeaders
        });
        check(searchFlightPage, {
            'nav.pl?page=menu&in=flights status is 200': (r) => r.status === 200
        });

        const citiesHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/welcome.pl?page=search`
        });
        let getFlightCities = http.get(`${BASE_URL}/cgi-bin/reservations.pl?page=welcome`, {
            headers: citiesHeaders
        });
        const isCitiesOk = check(getFlightCities, {
            'reservations.pl status is 200': (r) => r.status === 200
        });

        if (isCitiesOk) {
            const bodyText = getFlightCities.body;
            const cityRegex = /<option.*?value=".*?".*?>(.*?)<\/option>/g;
            let match;
            while ((match = cityRegex.exec(bodyText)) !== null) {
                flightData.cityList.push(match[1]);
            }
            const departMatch = bodyText.match(/name="departDate"\s+value="([^"]+)"/);
            if (departMatch) flightData.departDate = departMatch[1];
            
            const returnMatch = bodyText.match(/name="returnDate"\s+value="([^"]+)"/);
            if (returnMatch) flightData.returnDate = returnMatch[1];
        }
    });
    return flightData;
}
/* --------------------------------------------------- */
/* --- Begin One Way Ticket Transaction Controller --- */
/* --------------------------------------------------- */
export function oneWayTicketTransaction(BASE_URL, flightData) {
    group('04_One_Way_Ticket_Transaction', () => {
        const selectHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/reservations.pl?page=welcome`,
            'Origin': BASE_URL,
            'Upgrade-Insecure-Requests': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        });

        if (!flightData.cityList || flightData.cityList.length === 0) {
            console.error('Ошибка: Список городов пуст!');
            return;
        }

        const departCity = getRandomElement(flightData.cityList);
        const arriveCity = getRandomElement(flightData.cityList);

        const selectData = {
            'advanceDiscount': '0',
            'depart': departCity,
            'departDate': flightData.departDate,
            'arrive': arriveCity,
            'returnDate': flightData.returnDate,
            'numPassengers': queryParams.numPassengers,
            'seatPref': 'None',
            'seatType': 'Coach',
            'findFlights.x': '42',
            'findFlights.y': '6',
            '.cgifields': ['roundtrip', 'seatType', 'seatPref'] 
        };

        let selectCitiesAndDates = http.post(`${BASE_URL}/cgi-bin/reservations.pl`, selectData, {
            headers: selectHeaders
        });
        const isSelectOk = check(selectCitiesAndDates, {
            'selectCitiesAndDates status is 200': (r) => r.status === 200
        });

        let outboundFlights = [];
        if (isSelectOk) {
            const flightRegex = /name="outboundFlight" value="([^"]+)"/g;
            let match;
            while ((match = flightRegex.exec(selectCitiesAndDates.body)) !== null) {
                outboundFlights.push(match[1]);
            }
        }
        const chosenFlight = outboundFlights.length > 0 ? getRandomElement(outboundFlights) : '020;351;05/18/2026';

        const outboundHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/reservations.pl`,
            'Origin': BASE_URL,
            'Content-Type': 'application/x-www-form-urlencoded'
        });
        const outboundData = {
            'outboundFlight': chosenFlight,
            'numPassengers': queryParams.numPassengers,
            'advanceDiscount': '0',
            'seatType': 'Coach',
            'seatPref': 'None',
            'reserveFlights.x': '55',
            'reserveFlights.y': '6'
        };
        let selectOutboundFlights = http.post(`${BASE_URL}/cgi-bin/reservations.pl`, outboundData, {
            headers: outboundHeaders
        });
        check(selectOutboundFlights, {
            'selectOutboundFlights status is 200': (r) => r.status === 200
        });

        const paymentHeaders = Object.assign({}, baseHeaders, {
            'Referer': `${BASE_URL}/cgi-bin/reservations.pl`,
            'Origin': BASE_URL,
            'Content-Type': 'application/x-www-form-urlencoded'
        });
        const paymentData = {
            'firstName': queryParams.firstName,
            'lastName': queryParams.lastName,
            'address1': queryParams.address1,
            'address2': queryParams.address2,
            'pass1': queryParams.pass1,
            'creditCard': queryParams.creditCard,
            'expDate': queryParams.expDate,
            'oldCCOption': '',
            'numPassengers': queryParams.numPassengers,
            'seatType': 'Coach',
            'seatPref': 'None',
            'outboundFlight': chosenFlight,
            'advanceDiscount': '0',
            'returnFlight': '',
            'JSFormSubmit': 'off',
            'buyFlights.x': '73',
            'buyFlights.y': '16',
            '.cgifields': 'saveCC'
        };
        let postPayment = http.post(`${BASE_URL}/cgi-bin/reservations.pl`, paymentData, {
            headers: paymentHeaders
        });
        check(postPayment, {
            'postPayment status is 200': (r) => r.status === 200
        });
    });
}
