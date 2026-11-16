// ─── naming.js ───────────────────────────────────────────────────────────────
// /naming
// AI 호출 없이 내장 데이터베이스로 즉시 동작하는 오프라인 랜덤 이름 생성기 & 영어 애칭 사전.
// - 한국어 이름: 요즘(성+이름) / 옛날(성+이름) / 시대물(이름만)
// - 영어 이름: 여자 / 남자 / Family Name / 애칭 (본명 ↔ 애칭 양방향 검색)

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { createPanel, getPanelBody, closePanel } from './panel-ui.js';
import { copyText } from './state.js';

const PANEL_ID = 'ws-naming-panel';

// 한국어 성씨 (빈도가 높은 성씨를 자연스럽게 소폭 가중)
const KR_SURNAMES = [
    '김', '김', '이', '이', '박', '박', '최', '정', '강', '조',
    '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안',
    '송', '류', '전', '홍', '고', '문', '양', '손', '배', '백',
    '허', '유', '남', '심', '노', '하', '곽', '성', '차', '주',
    '우', '구', '민', '진', '엄', '원', '채', '천', '현', '방',
    '공', '여', '도', '연', '석', '선',
];

// 현대·옛날 4글자 조합용 한국 실존 복성
const KR_DOUBLE_SURNAMES = [
    '남궁', '남궁', '선우', '선우', '황보', '제갈', '사공', '서문', '독고',
];

// ── 요즘 여자 / 요즘 남자 ───────────────────────────────────────────────────
const KR_FEMALE_NAMES = [
    '서연', '하윤', '지우', '서윤', '민서', '수아', '윤서', '지유', '채원', '지아',
    '하은', '다은', '예은', '소율', '예진', '시은', '연우', '아린', '유나', '세아',
    '나연', '가은', '지안', '혜린', '은서', '희원', '도연', '수빈', '서영', '태희',
    '주아', '현서', '라희', '재인', '보민', '이서', '하린', '유진', '소현', '예림',
    '지민', '아영', '유리', '다인', '연서', '소윤', '혜원', '은채', '시연', '수현',
    '예나', '채린', '승아', '주연', '선우', '예원', '서아', '리원', '해인', '서현',
    '민지', '지원', '다혜', '지윤', '소연', '세연', '규리', '나현', '윤아', '희주',
    '혜진', '가영', '유림', '민채', '소은', '지혜', '여진', '채영', '지효', '서희',
    '수연', '다연', '유주', '하연', '희진', '재희', '혜수', '아현', '나은', '연희',
    '가희', '채은', '서진', '유정', '다영', '세희', '혜인', '수민', '나린', '다정',
    '윤진', '은우', '보영', '예서', '하영', '소미', '세은', '유빈', '연주',
    '효진', '현정', '은지', '정원', '서정', '지현', '수진', '민아', '시아', '아름',
    '태은', '채아', '하경', '다솜', '솔아', '혜성', '은비', '소정', '가람', '단아',
    '로아', '은유', '주원', '채윤', '수인', '세린', '현아', '민경', '보경',
];

const KR_MODERN_F_1 = [
    '봄', '결', '별', '솔', '린', '율', '담', '빛', '윤', '연', '채', '안',
    '빈', '설', '원', '해', '수', '란', '진', '현', '아', '은', '하', '이',
];

const KR_MODERN_F_3 = [
    '빛나라', '은가람', '해오름', '푸르름', '보라미', '아라온', '온누리', '봄내음',
    '마음결', '새벽별', '여름이', '겨울이', '가온길', '단비결',
];

const KR_MALE_NAMES = [
    '도현', '민준', '서준', '주원', '예준', '시우', '하준', '지호', '지훈', '건우',
    '현우', '우진', '선우', '유준', '연우', '정우', '승우', '민재', '현준', '준우',
    '준서', '시윤', '태윤', '도윤', '은우', '재민', '수현', '재원', '진우', '지우',
    '태현', '승현', '영훈', '동현', '성민', '성훈', '민성', '윤우', '규민', '재현',
    '승민', '기현', '호진', '찬영', '형준', '준혁', '시현', '상우', '대현', '지성',
    '유찬', '강민', '세준', '경민', '태민', '이준', '승호', '민규', '진호', '정훈',
    '은찬', '한결', '태오', '세현', '하율', '주안', '단우', '이안', '해성', '도원',
    '윤호', '재윤', '석진', '현성', '원준', '준호', '승환', '성현', '동욱', '민혁',
    '영준', '지환', '정민', '태훈', '찬우', '인성', '수호', '우현', '규현', '성준',
    '민호', '진혁', '상현', '재영', '우석', '준영', '지한', '서진', '태양', '은성',
    '윤성', '강현', '다온', '도경', '동하', '류현', '무현', '범준', '서우', '성빈',
    '세훈', '수혁', '승원', '시완', '아론', '연준', '예성', '용현', '우빈', '원재',
    '유건', '윤재', '은호', '이현', '인우', '재우', '재호', '정현', '준기', '진서',
    '찬민', '태성', '하민', '한빈', '현민', '호준', '효성', '태건', '승재', '지안',
];

const KR_MODERN_M_1 = [
    '현', '율', '결', '빈', '건', '진', '훈', '혁', '찬', '준', '원', '우',
    '솔', '민', '담', '산', '강', '호', '성', '윤', '영', '인', '재',
];

const KR_MODERN_M_3 = [
    '가온길', '온누리', '해오름', '푸르름', '아라온', '새벽별', '가람결', '해가람',
    '산마루', '하늘솔', '은가람', '빛가람',
];

// ── 옛날 여자 / 옛날 남자 (60~70년대 서정적·단정한 어른 이름) ───────────────────
const KR_RETRO_F_2 = [
    '숙희', '미숙', '영희', '정희', '명희', '은희', '선희', '연희', '진희', '경희',
    '현희', '수희', '문희', '성희', '혜숙', '현숙', '정숙', '영숙', '경숙', '인숙',
    '명숙', '순희', '미영', '미경', '선미', '영미', '은미', '정미', '혜미', '수미',
    '지영', '은영', '선영', '혜영', '수영', '주영', '화영', '미선', '은선', '혜선',
    '지선', '유선', '경선', '영선', '명선', '은경', '혜경', '수경', '선경', '유경',
    '문경', '인경', '재경', '애경', '수정', '은정', '혜정', '현정', '미정', '유정',
    '효정', '서정', '윤정', '희정', '경아', '현아', '선아', '정아', '은아', '영아',
    '수진', '현진', '혜진', '영진', '유진', '명진', '미진', '은주', '현주', '영주',
    '선주', '명주', '혜주', '정원', '혜원', '지원', '수원', '채원', '미란', '영란',
    '숙란', '혜란', '옥란', '경란', '수련', '혜련', '정연', '수연', '미연', '승연',
    '인애', '순애', '영애', '정애', '명애', '경애', '혜옥', '선옥', '정옥', '명옥',
    '순옥', '미화', '정화', '선화', '영화', '경화', '은실', '진실', '성실', '보경',
    '혜인', '수인', '영인', '경혜', '은혜', '순혜', '정혜', '영혜', '인혜', '세영',
    '세희', '윤희', '송희', '춘희', '금희', '난희', '소영', '청아', '다혜', '우영',
    '해숙', '윤숙',
];

const KR_RETRO_F_1 = [
    '란', '숙', '희', '영', '선', '혜', '진', '정', '옥', '화', '애', '설', '순', '연', '윤', '주', '미',
];

const KR_RETRO_M_2 = [
    '현규', '성규', '민규', '인규', '태규', '진규', '동규', '재규', '상규', '영규',
    '철수', '영수', '성수', '경수', '진수', '명수', '정수', '현수', '기수', '병수',
    '영호', '성호', '정호', '경호', '진호', '인호', '명호', '철호', '상호', '준호',
    '동호', '원호', '재호', '석호', '태호', '영훈', '성훈', '정훈', '상훈', '재훈',
    '지훈', '경훈', '병훈', '기훈', '동훈', '현우', '성우', '정우', '상우', '영우',
    '진우', '동우', '재우', '병우', '승우', '영진', '성진', '현진', '우진', '동진',
    '상진', '명진', '원진', '형진', '석진', '영석', '현석', '인석', '우석', '민석',
    '준석', '경석', '재석', '태석', '기석', '영준', '성준', '현준', '형준', '동준',
    '상준', '명준', '원준', '영식', '경식', '정식', '현식', '상식', '인식', '원식',
    '성환', '영환', '정환', '명환', '재환', '경환', '지환', '승환', '영철', '성철',
    '현철', '명철', '원철', '기철', '재철', '병철', '상철', '인성', '진성', '우성',
    '민성', '기성', '해성', '태성', '윤성', '종현', '종호', '종훈', '종수', '종민',
    '종원', '종석', '종우', '종진', '창훈', '창호', '창수', '창민', '창현', '문수',
    '문호', '문석', '세훈', '세영', '윤호', '윤석', '선규', '도영', '기영', '신우',
    '덕우', '홍석', '범수',
];

const KR_RETRO_M_1 = [
    '규', '호', '석', '진', '영', '철', '수', '우', '성', '훈', '원', '준', '환', '현', '강', '민', '식',
];

// ── 시대물 여자 / 시대물 남자 (사극·동양풍·무협·선협 장르 불문) ───────────────────
const KR_PERIOD_F_2 = [
    '연화', '설화', '월영', '청아', '백설', '은하', '비연', '소연', '채련', '유화',
    '옥련', '화연', '매화', '난향', '설희', '연희', '명월', '추월', '단아', '서연',
    '수련', '청련', '백련', '홍련', '자운', '청운', '은설', '소월', '운희', '가연',
    '혜연', '단향', '여울', '아란', '소란', '월하', '설하', '연하', '비설', '설아',
    '화영', '채영', '영란', '옥란', '선화', '명화', '청화', '춘향', '유란', '서하',
    '해연', '세연', '선아', '효린', '소영', '지연', '연수', '은향', '사월', '연옥',
    '금옥', '진옥', '서윤', '현서', '혜원', '정화', '인화', '덕희', '경화', '명혜',
    '숙연', '은비', '유월', '오월', '하영', '연비', '설란', '청란', '초연', '단비',
    '설빈', '예빈', '연빈', '소담', '향란', '운아', '서아', '설영', '화란', '옥선',
    '금란', '채화', '진화', '비향', '여진', '현아', '수화', '청하', '하란', '선영',
];

const KR_PERIOD_F_1 = [
    '설', '화', '련', '월', '향', '옥', '비', '린', '란', '채',
    '운', '아', '소', '영', '청', '연', '서', '은', '홍', '매',
];

const KR_PERIOD_M_2 = [
    '무영', '청운', '진혁', '현운', '백호', '창현', '유현', '도현', '수혁', '명훈',
    '승현', '준혁', '성현', '태현', '재헌', '서진', '지헌', '연호', '강혁', '운혁',
    '백현', '청명', '묵연', '현묵', '서운', '검우', '비류', '천우', '천명', '천휘',
    '무진', '무극', '적운', '한결', '도원', '도윤', '윤우', '서헌', '해원', '휘성',
    '청풍', '서풍', '담덕', '세현', '세진', '원우', '원진', '명준', '성준', '강호',
    '진우', '철우', '의현', '경현', '인우', '정우', '상현', '덕현', '윤성', '해성',
    '기현', '영휘', '휘준', '찬혁', '율현', '헌우', '우헌', '서휘', '은휘', '묵휘',
    '청현', '연우', '석훈', '진헌', '담우', '담현', '백진', '백강', '적혁', '운휘',
    '설운', '은우', '한울', '호연', '시헌', '정헌', '동현', '규현', '하진', '승휘',
    '도휘', '성휘', '강휘', '주원', '재윤', '도광', '태휘', '서경', '수현', '현진',
];

const KR_PERIOD_M_1 = [
    '운', '혁', '현', '진', '강', '연', '림', '휘', '준', '설',
    '백', '청', '혼', '묵', '산', '풍', '영', '류', '헌', '율',
];

const EN_FEMALE_NAMES = [
    'Evelyn', 'Clara', 'Violet', 'Alice', 'Eleanor', 'Nora', 'Iris', 'Charlotte',
    'Audrey', 'Lydia', 'Vivienne', 'Camille', 'Margot', 'Celeste', 'Beatrice', 'Daphne',
    'Hannah', 'Ruby', 'Stella', 'Naomi', 'Phoebe', 'Hazel', 'Julia', 'Madeline',
    'Sienna', 'Josephine', 'Freya', 'Valerie', 'Grace', 'Sophie', 'Elena', 'Claire',
    'Natalie', 'Lucy', 'Emma', 'Olivia', 'Amelia', 'Chloe', 'Abigail', 'Savannah',
    'Tessa', 'Genevieve', 'Juliette', 'Rosalie', 'Penelope', 'Sylvia', 'Fiona', 'Matilda',
    'Adelaide', 'Meredith', 'Helena', 'Cassandra', 'Lillian', 'Caroline', 'Bianca', 'Miranda',
    'Lorelei', 'Estelle', 'Ramona', 'Gwendolyn', 'Sabrina', 'Serena', 'Valeria', 'Nadia',
    'Zoe', 'Harper', 'Aria', 'Scarlett', 'Victoria', 'Aurora', 'Isabelle', 'Celine',
    'Gabrielle', 'Margaux', 'Anastasia', 'Brielle', 'Colette', 'Delilah', 'Elodie', 'Flora',
    'Georgia', 'Heather', 'Ivy', 'Jocelyn', 'Katherine', 'Leah', 'Maeve', 'Noelle',
    'Ophelia', 'Paige', 'Quinn', 'Rachel', 'Summer', 'Tabitha', 'Vanessa', 'Wendy',
    'Aurelia', 'Beatrix', 'Claudia', 'Diana', 'Esther', 'Felicity', 'Gemma', 'Hope',
    'Ingrid', 'Jasmine', 'Kira', 'Laura', 'Melissa', 'Nina', 'Octavia', 'Paulina',
    'Rebecca', 'Simone', 'Theresa', 'Veronica', 'Whitney', 'Yvette', 'Zara', 'Rose',
    'Louise', 'Margaret', 'Marianne', 'Miriam', 'Priscilla', 'Ruth', 'Vera',
];

const EN_MALE_NAMES = [
    'Arthur', 'Julian', 'Sebastian', 'Theodore', 'Nathaniel', 'Oliver', 'Liam', 'Ethan',
    'Lucas', 'Henry', 'Daniel', 'Caleb', 'Gabriel', 'Adrian', 'Leo', 'Thomas',
    'Benjamin', 'Samuel', 'Nicholas', 'Vincent', 'Victor', 'Damian', 'Dominic', 'Elliot',
    'Alistair', 'Gideon', 'Kieran', 'Rowan', 'Felix', 'Colin', 'Miles', 'Owen',
    'Simon', 'Jasper', 'Marcus', 'Malcolm', 'Tristan', 'Harrison', 'Everett', 'Graham',
    'Bennett', 'Desmond', 'Lawrence', 'Raphael', 'Edmund', 'Lucian', 'Wesley', 'Nolan',
    'Emmett', 'Lachlan', 'Isaac', 'Ezra', 'Hugo', 'Declan', 'Conrad', 'Dorian',
    'Philip', 'Frederick', 'Jonathan', 'Garrett', 'Logan', 'Wyatt', 'Brooks', 'Xavier',
    'Jonas', 'Elias', 'Alexander', 'Andrew', 'Anthony', 'August', 'Beckett', 'Callum',
    'Cameron', 'Charles', 'Christian', 'Christopher', 'Cole', 'Connor', 'David', 'Dean',
    'Edward', 'Edwin', 'Elliott', 'Eric', 'Evan', 'Fabian', 'Finn', 'Francis',
    'Gavin', 'George', 'Grant', 'Gregory', 'Harvey', 'Hector', 'Ian', 'Jack',
    'Jacob', 'James', 'Jason', 'Jeremy', 'Joel', 'Joseph', 'Joshua', 'Jude',
    'Kenneth', 'Kevin', 'Killian', 'Landon', 'Leon', 'Leonard', 'Louis', 'Luke',
    'Martin', 'Mason', 'Matthew', 'Max', 'Michael', 'Morgan', 'Nathan', 'Oscar',
    'Patrick', 'Paul', 'Peter', 'Quentin', 'Raymond', 'Reuben', 'Richard', 'Robert',
    'Roman', 'Ronan', 'Russell', 'Ryan', 'Seth', 'Silas', 'Spencer', 'Stephen',
    'Sterling', 'Tobias', 'Travis', 'Trevor', 'Valentin', 'Walter', 'Warren', 'William',
];

const EN_SURNAMES = [
    'Miller', 'Anderson', 'Bennett', 'Hayes', 'Collins', 'Stewart', 'Sullivan', 'Brooks',
    'Carter', 'Morgan', 'Reed', 'Foster', 'Fletcher', 'Parker', 'Ward', 'Palmer',
    'Mercer', 'Vance', 'Sterling', 'Caldwell', 'Hawthorne', 'Sinclair', 'Thornton', 'Whitaker',
    'Montgomery', 'Callahan', 'Fitzgerald', 'Donovan', 'Gallagher', 'Holloway', 'Kensington', 'Carrington',
    'Lockwood', 'Ashford', 'Bellamy', 'Monroe', 'Reynolds', 'Cooper', 'Edwards', 'Hughes',
    'Sanders', 'Griffin', 'Bryant', 'Hamilton', 'Spencer', 'Walsh', 'Mitchell', 'Rogers',
    'Powell', 'Campbell', 'Bailey', 'Coleman', 'Graham', 'Jenkins', 'Perry', 'Butler',
    'Barnes', 'Henderson', 'Fisher', 'Crawford', 'Adams', 'Alexander', 'Allen', 'Armstrong',
    'Austin', 'Baker', 'Barker', 'Barrett', 'Barton', 'Baxter', 'Becker', 'Bell',
    'Bishop', 'Blackwood', 'Blair', 'Blake', 'Bowen', 'Bradley', 'Bradshaw', 'Brennan',
    'Burton', 'Byrne', 'Cameron', 'Carey', 'Carlisle', 'Carlson', 'Carpenter', 'Carroll',
    'Chambers', 'Chandler', 'Chapman', 'Chase', 'Clark', 'Clarke', 'Clayton', 'Clements',
    'Clifford', 'Collier', 'Conway', 'Cook', 'Cross', 'Cunningham', 'Curtis', 'Dalton',
    'Daniels', 'Davenport', 'Davidson', 'Davies', 'Davis', 'Dawson', 'Dean', 'Delaney',
    'Dixon', 'Douglas', 'Doyle', 'Drake', 'Duncan', 'Dunn', 'Elliott', 'Ellis',
    'Emerson', 'Evans', 'Farrell', 'Ferguson', 'Fields', 'Finch', 'Fleming', 'Ford',
    'Fox', 'Franklin', 'Fraser', 'Freeman', 'Frost', 'Fuller', 'Gardner', 'Garner',
    'Gibson', 'Gilbert', 'Gordon', 'Grant', 'Graves', 'Gray', 'Green', 'Greene',
    'Hale', 'Hall', 'Hancock', 'Harding', 'Hardy', 'Harper', 'Harris', 'Harrison',
    'Hart', 'Harvey', 'Hastings', 'Hayden', 'Heath', 'Hicks', 'Higgins', 'Hill',
    'Hoffman', 'Holland', 'Holmes', 'Holt', 'Hopkins', 'Howard', 'Hudson', 'Hunt',
    'Hunter', 'Irwin', 'Jackson', 'Jacobs', 'Jameson', 'Jennings', 'Jensen', 'Johns',
    'Johnson', 'Johnston', 'Jones', 'Jordan', 'Keller', 'Kelly', 'Kendall', 'Kennedy',
    'Kerr', 'King', 'Knight', 'Lambert', 'Lancaster', 'Lane', 'Langford', 'Lawrence',
    'Lawson', 'Lee', 'Lennox', 'Leonard', 'Lewis', 'Lindsay', 'Lloyd', 'Logan',
    'Long', 'Lowe', 'Lucas', 'Lynch', 'Lyons', 'MacAllister', 'Mackenzie', 'Maddox',
    'Malone', 'Manning', 'Marsh', 'Marshall', 'Martin', 'Mason', 'Mathews', 'Matthews',
    'Maxwell', 'McCarthy', 'McDonald', 'McGregor', 'McKay', 'McKenzie', 'Meyer', 'Miles',
    'Mills', 'Moore', 'Moran', 'Morris', 'Morrison', 'Morton', 'Murphy', 'Murray',
    'Myers', 'Nash', 'Nelson', 'Newman', 'Newton', 'Nichols', 'Nolan', 'Norman',
    'Norris', 'Norton', 'O\'Brien', 'O\'Connor', 'Oliver', 'Olson', 'Osborne', 'Owen',
    'Owens', 'Page', 'Payne', 'Pearson', 'Perkins', 'Peters', 'Peterson', 'Phillips',
    'Pierce', 'Porter', 'Potter', 'Preston', 'Price', 'Quinn', 'Ramsey', 'Randall',
    'Ray', 'Raymond', 'Reese', 'Reid', 'Rhodes', 'Rice', 'Richards', 'Richardson',
    'Riley', 'Roberts', 'Robertson', 'Robinson', 'Ross', 'Rowe', 'Russell', 'Ryan',
    'Saunders', 'Sawyer', 'Schmidt', 'Scott', 'Sharp', 'Shaw', 'Shelton', 'Shepherd',
    'Sheridan', 'Sherman', 'Shields', 'Simmons', 'Simpson', 'Sims', 'Sloan', 'Smith',
    'Snyder', 'Stafford', 'Stanley', 'Steele', 'Stephens', 'Stevens', 'Stevenson', 'Stone',
    'Strickland', 'Strong', 'Sutton', 'Swanson', 'Tate', 'Taylor', 'Terry', 'Thomas',
    'Thompson', 'Thomson', 'Todd', 'Townsend', 'Tucker', 'Turner', 'Tyler', 'Vaughan',
    'Vaughn', 'Vincent', 'Wade', 'Wagner', 'Walker', 'Wallace', 'Walls', 'Walters',
    'Walton', 'Warner', 'Warren', 'Washington', 'Waters', 'Watkins', 'Watson', 'Watts',
    'Weaver', 'Webb', 'Weber', 'Webster', 'Wells', 'West', 'Wheeler', 'White',
    'Whitley', 'Whitney', 'Wilder', 'Wilkins', 'Wilkinson', 'Williams', 'Williamson', 'Willis',
    'Wilson', 'Winters', 'Wise', 'Wolfe', 'Wood', 'Woods', 'Woodward', 'Wright',
    'Wyatt', 'Yates', 'Young', 'Zimmerman',
];

const KR_POOLS = {
    modern_f: {
        surnames1: KR_SURNAMES,
        surnames2: KR_DOUBLE_SURNAMES,
        given1: [...new Set(KR_MODERN_F_1)],
        given2: [...new Set(KR_FEMALE_NAMES)],
        given3: [...new Set(KR_MODERN_F_3)],
    },
    modern_m: {
        surnames1: KR_SURNAMES,
        surnames2: KR_DOUBLE_SURNAMES,
        given1: [...new Set(KR_MODERN_M_1)],
        given2: [...new Set(KR_MALE_NAMES)],
        given3: [...new Set(KR_MODERN_M_3)],
    },
    retro_f: {
        surnames1: KR_SURNAMES,
        surnames2: KR_DOUBLE_SURNAMES,
        given1: [...new Set(KR_RETRO_F_1)],
        given2: [...new Set(KR_RETRO_F_2)],
        given3: [],
    },
    retro_m: {
        surnames1: KR_SURNAMES,
        surnames2: KR_DOUBLE_SURNAMES,
        given1: [...new Set(KR_RETRO_M_1)],
        given2: [...new Set(KR_RETRO_M_2)],
        given3: [],
    },
    period_f: {
        givenOnly: true,
        surnames1: [],
        surnames2: [],
        given1: [...new Set(KR_PERIOD_F_1)],
        given2: [...new Set(KR_PERIOD_F_2)],
        given3: [],
    },
    period_m: {
        givenOnly: true,
        surnames1: [],
        surnames2: [],
        given1: [...new Set(KR_PERIOD_M_1)],
        given2: [...new Set(KR_PERIOD_M_2)],
        given3: [],
    },
};

const POOLS = {
    enFemale: [...new Set(EN_FEMALE_NAMES)],
    enMale: [...new Set(EN_MALE_NAMES)],
    enSurname: [...new Set(EN_SURNAMES)],
};

// 영어 본명 ↔ 애칭 양방향 사전: [본명, 성별('f'|'m'), 애칭 배열]
const EN_NICKNAME_ENTRIES = [
    // 여성 이름
    ['Abigail', 'f', ['Abby', 'Abbie', 'Gail']],
    ['Adelaide', 'f', ['Addy', 'Ada', 'Adele', 'Della']],
    ['Adrienne', 'f', ['Adri']],
    ['Alexandra', 'f', ['Alex', 'Lexi', 'Lex', 'Ali', 'Sasha', 'Sandra', 'Sandy']],
    ['Alice', 'f', ['Ali', 'Allie', 'Lissie']],
    ['Allison', 'f', ['Allie', 'Ally', 'Ali']],
    ['Amanda', 'f', ['Mandy', 'Amy']],
    ['Amelia', 'f', ['Amy', 'Mia', 'Mel', 'Millie', 'Lia']],
    ['Anastasia', 'f', ['Ana', 'Stacy', 'Tasha', 'Anya', 'Sia']],
    ['Andrea', 'f', ['Andi', 'Andy']],
    ['Angela', 'f', ['Angie']],
    ['Angelica', 'f', ['Angie', 'Angel']],
    ['Annabelle', 'f', ['Anna', 'Annie', 'Belle', 'Bella', 'Elle']],
    ['Anne', 'f', ['Annie', 'Nan', 'Nancy']],
    ['Arielle', 'f', ['Ari', 'Elle', 'Ellie']],
    ['Ashley', 'f', ['Ash']],
    ['Aurora', 'f', ['Rory', 'Aura']],
    ['Barbara', 'f', ['Barb', 'Barbie', 'Babs']],
    ['Beatrice', 'f', ['Bea', 'Bee', 'Trix', 'Trixie']],
    ['Beatrix', 'f', ['Bea', 'Trix', 'Trixie']],
    ['Bernadette', 'f', ['Bernie', 'Etta']],
    ['Bianca', 'f', ['Bea', 'Bia']],
    ['Bridget', 'f', ['Bree', 'Biddy']],
    ['Brielle', 'f', ['Bree', 'Elle']],
    ['Camilla', 'f', ['Cami', 'Cam', 'Millie', 'Milly']],
    ['Camille', 'f', ['Cami', 'Cam', 'Millie', 'Elle']],
    ['Caroline', 'f', ['Caro', 'Carrie', 'Cara', 'Lina']],
    ['Cassandra', 'f', ['Cass', 'Cassie', 'Cassy', 'Sandra', 'Sandy']],
    ['Catherine', 'f', ['Kate', 'Katie', 'Kat', 'Kathy', 'Kit', 'Kay']],
    ['Celeste', 'f', ['Cece', 'Celie']],
    ['Celine', 'f', ['Cece', 'Lina']],
    ['Charlotte', 'f', ['Charlie', 'Lottie', 'Char']],
    ['Christina', 'f', ['Chris', 'Chrissy', 'Tina', 'Christy']],
    ['Christine', 'f', ['Chris', 'Chrissy', 'Christy']],
    ['Clara', 'f', ['Clary']],
    ['Clarissa', 'f', ['Claire', 'Clary', 'Rissa']],
    ['Claudia', 'f', ['Claud']],
    ['Clementine', 'f', ['Clem', 'Clemmie', 'Tina']],
    ['Constance', 'f', ['Connie']],
    ['Courtney', 'f', ['Court']],
    ['Cynthia', 'f', ['Cindy', 'Cyn']],
    ['Danielle', 'f', ['Dani', 'Dan', 'Elle']],
    ['Deborah', 'f', ['Deb', 'Debbie']],
    ['Delilah', 'f', ['Lilah', 'Del', 'Della']],
    ['Diana', 'f', ['Di']],
    ['Dorothy', 'f', ['Dot', 'Dotty', 'Dolly', 'Dora']],
    ['Elaine', 'f', ['Elle', 'Ellie', 'Lainey']],
    ['Eleanor', 'f', ['Ellie', 'Elle', 'Ella', 'Nora', 'Nell', 'Nellie', 'Lenore']],
    ['Elisabeth', 'f', ['Liz', 'Lizzie', 'Beth', 'Eliza', 'Elle', 'Lisa']],
    ['Elizabeth', 'f', ['Liz', 'Lizzie', 'Beth', 'Betty', 'Eliza', 'Elle', 'Bess', 'Libby', 'Liza']],
    ['Ellen', 'f', ['Elle', 'Ellie', 'Nell']],
    ['Elodie', 'f', ['Elle', 'Ellie', 'Dee']],
    ['Eloise', 'f', ['Elle', 'Ellie', 'Lou', 'Lulu']],
    ['Emily', 'f', ['Em', 'Emmie', 'Millie']],
    ['Emmeline', 'f', ['Em', 'Emma', 'Emmie', 'Lina']],
    ['Estelle', 'f', ['Elle', 'Ellie', 'Essie', 'Stella']],
    ['Esther', 'f', ['Essie', 'Esti']],
    ['Evelyn', 'f', ['Evie', 'Eve', 'Lyn']],
    ['Felicity', 'f', ['Flick', 'Lissie']],
    ['Fiona', 'f', ['Fi']],
    ['Florence', 'f', ['Flo', 'Flora', 'Flossie']],
    ['Frances', 'f', ['Fran', 'Frankie', 'Franny']],
    ['Francesca', 'f', ['Fran', 'Frankie', 'Cesca']],
    ['Gabriella', 'f', ['Gabby', 'Gaby', 'Ella', 'Brielle']],
    ['Gabrielle', 'f', ['Gabby', 'Gaby', 'Elle', 'Brielle']],
    ['Gemma', 'f', ['Gem', 'Em']],
    ['Genevieve', 'f', ['Gen', 'Ginny', 'Evie', 'Vivi', 'Jenny']],
    ['Georgia', 'f', ['Georgie', 'Gia', 'Gigi']],
    ['Geraldine', 'f', ['Gerry', 'Geri', 'Dina']],
    ['Gwendolyn', 'f', ['Gwen', 'Wendy', 'Winnie', 'Lyn']],
    ['Hannah', 'f', ['Han', 'Hanny']],
    ['Harriet', 'f', ['Hattie', 'Harry']],
    ['Helena', 'f', ['Helen', 'Lena', 'Elena', 'Nell']],
    ['Henrietta', 'f', ['Hettie', 'Etta', 'Henny']],
    ['Honora', 'f', ['Nora', 'Honor']],
    ['Ingrid', 'f', ['Inga']],
    ['Isabel', 'f', ['Izzy', 'Isa', 'Belle']],
    ['Isabella', 'f', ['Izzy', 'Bella', 'Belle', 'Isa', 'Elle']],
    ['Isabelle', 'f', ['Izzy', 'Belle', 'Bella', 'Isa', 'Elle']],
    ['Jacqueline', 'f', ['Jackie', 'Jacqui']],
    ['Jasmine', 'f', ['Jas', 'Jaz', 'Mina']],
    ['Jennifer', 'f', ['Jen', 'Jenny']],
    ['Jessica', 'f', ['Jess', 'Jessie']],
    ['Jocelyn', 'f', ['Joss', 'Lyn', 'Jo']],
    ['Josephine', 'f', ['Josie', 'Jo', 'Jojo', 'Joey']],
    ['Julia', 'f', ['Julie', 'Jules']],
    ['Juliette', 'f', ['Julie', 'Jules', 'Ettie']],
    ['Katherine', 'f', ['Kate', 'Katie', 'Kat', 'Kathy', 'Kit', 'Kay']],
    ['Kathleen', 'f', ['Kate', 'Katie', 'Kathy', 'Kay', 'Kat']],
    ['Kathryn', 'f', ['Kate', 'Katie', 'Kat', 'Kathy', 'Kay']],
    ['Kimberly', 'f', ['Kim', 'Kimmy']],
    ['Laura', 'f', ['Laurie', 'Lori']],
    ['Lauren', 'f', ['Laurie', 'Ren']],
    ['Leonora', 'f', ['Nora', 'Lenore', 'Leo']],
    ['Lillian', 'f', ['Lily', 'Lilly', 'Lil']],
    ['Lorelei', 'f', ['Lori', 'Rory', 'Lora']],
    ['Louise', 'f', ['Lou', 'Lulu']],
    ['Lucinda', 'f', ['Lucy', 'Cindy', 'Luce']],
    ['Lucy', 'f', ['Lulu', 'Luce']],
    ['Madeline', 'f', ['Maddie', 'Maddy', 'Lena']],
    ['Madison', 'f', ['Maddie', 'Maddy']],
    ['Maeve', 'f', ['Mae', 'Evie']],
    ['Margaret', 'f', ['Maggie', 'Meg', 'Peggy', 'Peg', 'Marge', 'Daisy', 'Greta', 'Rita']],
    ['Marianne', 'f', ['Mari', 'Anne', 'Annie']],
    ['Matilda', 'f', ['Tilly', 'Tilda', 'Mattie', 'Matti']],
    ['Melanie', 'f', ['Mel']],
    ['Melissa', 'f', ['Mel', 'Missy', 'Lissa']],
    ['Meredith', 'f', ['Meri', 'Merry']],
    ['Michelle', 'f', ['Mich', 'Shelly', 'Elle']],
    ['Millicent', 'f', ['Millie', 'Milly']],
    ['Mirabelle', 'f', ['Mira', 'Belle', 'Bella', 'Elle']],
    ['Miranda', 'f', ['Mira', 'Randi', 'Mandy']],
    ['Miriam', 'f', ['Miri', 'Mimi', 'Mim']],
    ['Natalie', 'f', ['Nat', 'Nattie', 'Tali']],
    ['Natasha', 'f', ['Tasha', 'Nat', 'Tash']],
    ['Nicole', 'f', ['Nicki', 'Nicky', 'Nico']],
    ['Noelle', 'f', ['Elle', 'Nell', 'Noel']],
    ['Olivia', 'f', ['Liv', 'Livvy', 'Ollie', 'Via']],
    ['Ophelia', 'f', ['Lia', 'Phelia']],
    ['Pamela', 'f', ['Pam']],
    ['Patricia', 'f', ['Pat', 'Patty', 'Patsy', 'Tricia']],
    ['Paulina', 'f', ['Paula', 'Polly', 'Lina']],
    ['Penelope', 'f', ['Penny', 'Poppy', 'Nell']],
    ['Philippa', 'f', ['Pippa', 'Pip', 'Phil']],
    ['Priscilla', 'f', ['Cilla', 'Pris', 'Prissy']],
    ['Rachel', 'f', ['Rae', 'Rach']],
    ['Ramona', 'f', ['Mona', 'Romy']],
    ['Rebecca', 'f', ['Becca', 'Becky', 'Bec']],
    ['Rosalie', 'f', ['Rose', 'Rosie', 'Rosa']],
    ['Rosalind', 'f', ['Rose', 'Rosie', 'Linda']],
    ['Rose', 'f', ['Rosie', 'Rosa']],
    ['Rosemary', 'f', ['Rose', 'Rosie', 'Mary']],
    ['Sabrina', 'f', ['Bree', 'Rina', 'Brina']],
    ['Samantha', 'f', ['Sam', 'Sammy']],
    ['Sarah', 'f', ['Sally', 'Sadie']],
    ['Savannah', 'f', ['Sav', 'Savvy', 'Anna']],
    ['Scarlett', 'f', ['Scar', 'Letty']],
    ['Serena', 'f', ['Rena', 'Sera']],
    ['Simone', 'f', ['Sim', 'Mona']],
    ['Sophia', 'f', ['Sophie', 'Soph']],
    ['Stephanie', 'f', ['Steph', 'Stevie']],
    ['Susan', 'f', ['Sue', 'Suzy', 'Susie']],
    ['Suzanne', 'f', ['Sue', 'Suzy', 'Susie']],
    ['Sylvia', 'f', ['Sylvie', 'Syl']],
    ['Tabitha', 'f', ['Tabby', 'Tabs']],
    ['Tessa', 'f', ['Tess']],
    ['Theresa', 'f', ['Tess', 'Tessa', 'Terry', 'Tracy']],
    ['Valeria', 'f', ['Val', 'Lia']],
    ['Valerie', 'f', ['Val']],
    ['Vanessa', 'f', ['Nessa', 'Van', 'Vannie']],
    ['Veronica', 'f', ['Ronnie', 'Vera', 'Vero', 'Nica']],
    ['Victoria', 'f', ['Vicky', 'Vic', 'Tori', 'Vicki']],
    ['Vivienne', 'f', ['Viv', 'Vivi', 'Evie']],
    ['Winifred', 'f', ['Winnie', 'Freddie']],
    // 남성 이름
    ['Abraham', 'm', ['Abe', 'Bram']],
    ['Albert', 'm', ['Al', 'Bert', 'Bertie']],
    ['Alexander', 'm', ['Alex', 'Xander', 'Sasha', 'Sandy', 'Al']],
    ['Alfred', 'm', ['Al', 'Alf', 'Alfie', 'Fred']],
    ['Alistair', 'm', ['Al', 'Ali']],
    ['Andrew', 'm', ['Andy', 'Drew']],
    ['Anthony', 'm', ['Tony', 'Ant']],
    ['Arthur', 'm', ['Art', 'Artie']],
    ['August', 'm', ['Auggie', 'Gus']],
    ['Augustus', 'm', ['Auggie', 'Gus']],
    ['Bartholomew', 'm', ['Bart', 'Bat']],
    ['Beckett', 'm', ['Beck']],
    ['Benjamin', 'm', ['Ben', 'Benny', 'Benji']],
    ['Bernard', 'm', ['Bernie', 'Ben']],
    ['Bradley', 'm', ['Brad']],
    ['Caleb', 'm', ['Cal']],
    ['Callum', 'm', ['Cal']],
    ['Calvin', 'm', ['Cal']],
    ['Cameron', 'm', ['Cam', 'Ron']],
    ['Charles', 'm', ['Charlie', 'Chuck', 'Chaz']],
    ['Christian', 'm', ['Chris', 'Kit']],
    ['Christopher', 'm', ['Chris', 'Topher', 'Kit']],
    ['Conrad', 'm', ['Con', 'Rad']],
    ['Daniel', 'm', ['Dan', 'Danny']],
    ['David', 'm', ['Dave', 'Davey', 'Davy']],
    ['Desmond', 'm', ['Des']],
    ['Dominic', 'm', ['Dom', 'Nic']],
    ['Donald', 'm', ['Don', 'Donnie']],
    ['Douglas', 'm', ['Doug']],
    ['Edmund', 'm', ['Ed', 'Eddie', 'Ned', 'Ted']],
    ['Edward', 'm', ['Ed', 'Eddie', 'Ned', 'Ted', 'Teddy']],
    ['Edwin', 'm', ['Ed', 'Eddie', 'Win']],
    ['Elias', 'm', ['Eli']],
    ['Elijah', 'm', ['Eli']],
    ['Elliot', 'm', ['Eli']],
    ['Elliott', 'm', ['Eli']],
    ['Ernest', 'm', ['Ernie']],
    ['Eugene', 'm', ['Gene']],
    ['Francis', 'm', ['Frank', 'Frankie', 'Fran']],
    ['Franklin', 'm', ['Frank', 'Frankie']],
    ['Frederick', 'm', ['Fred', 'Freddy', 'Freddie', 'Fritz']],
    ['Gabriel', 'm', ['Gabe', 'Gabby']],
    ['Gerald', 'm', ['Gerry', 'Jerry']],
    ['Gideon', 'm', ['Gid']],
    ['Gilbert', 'm', ['Gil', 'Bert']],
    ['Gregory', 'm', ['Greg', 'Rory']],
    ['Harold', 'm', ['Hal', 'Harry']],
    ['Harrison', 'm', ['Harry', 'Harris']],
    ['Henry', 'm', ['Hal', 'Harry', 'Hank']],
    ['Herbert', 'm', ['Herb', 'Bert', 'Bertie']],
    ['Jack', 'm', ['Jackie']],
    ['Jackson', 'm', ['Jack', 'Jax']],
    ['Jacob', 'm', ['Jake', 'Coby']],
    ['James', 'm', ['Jim', 'Jimmy', 'Jamie']],
    ['Jason', 'm', ['Jay', 'Jase']],
    ['Jeremiah', 'm', ['Jerry', 'Jem']],
    ['Jeremy', 'm', ['Jerry', 'Jem']],
    ['John', 'm', ['Jack', 'Johnny', 'Jon']],
    ['Jonathan', 'm', ['Jon', 'Jonny', 'Nathan', 'Nate']],
    ['Joseph', 'm', ['Joe', 'Joey', 'Jo']],
    ['Joshua', 'm', ['Josh']],
    ['Julian', 'm', ['Jules', 'Ian']],
    ['Kenneth', 'm', ['Ken', 'Kenny']],
    ['Kevin', 'm', ['Kev']],
    ['Laurence', 'm', ['Larry', 'Laurie']],
    ['Lawrence', 'm', ['Larry', 'Laurie', 'Lawrie']],
    ['Leonard', 'm', ['Leo', 'Len', 'Lenny']],
    ['Leonardo', 'm', ['Leo', 'Nardo']],
    ['Leopold', 'm', ['Leo', 'Poldi']],
    ['Louis', 'm', ['Lou', 'Louie']],
    ['Lucas', 'm', ['Luke', 'Lou']],
    ['Lucian', 'm', ['Luke', 'Luc', 'Lucius']],
    ['Malcolm', 'm', ['Mal', 'Mac']],
    ['Marcus', 'm', ['Marc', 'Mark']],
    ['Martin', 'm', ['Marty']],
    ['Matthew', 'm', ['Matt', 'Matty']],
    ['Maximilian', 'm', ['Max']],
    ['Maximus', 'm', ['Max']],
    ['Maxwell', 'm', ['Max']],
    ['Michael', 'm', ['Mike', 'Mikey', 'Mick', 'Mickey']],
    ['Nathan', 'm', ['Nate', 'Nat']],
    ['Nathaniel', 'm', ['Nate', 'Nat', 'Nathan', 'Than']],
    ['Nicholas', 'm', ['Nick', 'Nicky', 'Nico']],
    ['Oliver', 'm', ['Ollie', 'Olly']],
    ['Patrick', 'm', ['Pat', 'Paddy', 'Rick']],
    ['Peter', 'm', ['Pete']],
    ['Philip', 'm', ['Phil', 'Pip']],
    ['Quentin', 'm', ['Quin', 'Q']],
    ['Raphael', 'm', ['Raph', 'Rafe']],
    ['Raymond', 'm', ['Ray']],
    ['Reuben', 'm', ['Rube', 'Ben']],
    ['Richard', 'm', ['Rich', 'Richie', 'Rick', 'Ricky', 'Dick']],
    ['Robert', 'm', ['Rob', 'Robbie', 'Bob', 'Bobby', 'Bert']],
    ['Ronald', 'm', ['Ron', 'Ronnie']],
    ['Russell', 'm', ['Russ']],
    ['Samuel', 'm', ['Sam', 'Sammy']],
    ['Sebastian', 'm', ['Seb', 'Sebby', 'Bash', 'Bastian']],
    ['Simon', 'm', ['Si']],
    ['Spencer', 'm', ['Spence']],
    ['Stephen', 'm', ['Steve', 'Stevie']],
    ['Steven', 'm', ['Steve', 'Stevie']],
    ['Stewart', 'm', ['Stew']],
    ['Terence', 'm', ['Terry']],
    ['Theodore', 'm', ['Theo', 'Ted', 'Teddy']],
    ['Thomas', 'm', ['Tom', 'Tommy']],
    ['Timothy', 'm', ['Tim', 'Timmy']],
    ['Tobias', 'm', ['Toby']],
    ['Travis', 'm', ['Trav']],
    ['Trevor', 'm', ['Trev']],
    ['Valentin', 'm', ['Val']],
    ['Victor', 'm', ['Vic']],
    ['Vincent', 'm', ['Vince', 'Vinnie', 'Vin', 'Vinny']],
    ['Wallace', 'm', ['Wally']],
    ['Walter', 'm', ['Walt', 'Wally']],
    ['Wesley', 'm', ['Wes']],
    ['William', 'm', ['Will', 'Willy', 'Bill', 'Billy', 'Liam']],
    ['Xavier', 'm', ['Xav', 'Zave']],
    ['Zachary', 'm', ['Zach', 'Zack']],
];

const EN_NICK_BY_FULL = new Map();
const EN_FULL_BY_NICK = new Map();
const EN_NICK_SEARCH_INDEX = [];

(() => {
    const searchMap = new Map(); // lower -> { name, lower, sex }
    const trackSearchName = (name, sex) => {
        const lower = name.toLowerCase();
        const prev = searchMap.get(lower);
        if (!prev) {
            searchMap.set(lower, { name, lower, sex });
        } else if (prev.sex && prev.sex !== sex) {
            prev.sex = '';
        }
    };

    for (const [name, sex, rawNicks] of EN_NICKNAME_ENTRIES) {
        const nicks = [...new Set(rawNicks)];
        const lowerFull = name.toLowerCase();
        EN_NICK_BY_FULL.set(lowerFull, { name, sex, nicks });
        trackSearchName(name, sex);

        for (const nick of nicks) {
            const lowerNick = nick.toLowerCase();
            let list = EN_FULL_BY_NICK.get(lowerNick);
            if (!list) {
                list = [];
                EN_FULL_BY_NICK.set(lowerNick, list);
            }
            if (!list.some(entry => entry.name === name)) {
                list.push({ name, sex });
            }
            trackSearchName(nick, sex);
        }
    }

    for (const list of EN_FULL_BY_NICK.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
    }
    EN_NICK_SEARCH_INDEX.push(
        ...[...searchMap.values()].sort((a, b) => a.name.localeCompare(b.name))
    );
})();

/**
 * 영어 이름 ↔ 애칭 양방향 오프라인 조회.
 * @param {string} rawQuery
 */
function lookupEnglishNicknames(rawQuery) {
    const query = String(rawQuery ?? '').trim();
    const q = query.toLowerCase();
    if (!q) {
        return { query: '', isEmpty: true, asFull: null, asNick: [], suggestions: [] };
    }

    const fullEntry = EN_NICK_BY_FULL.get(q);
    const asFull = fullEntry ? { name: fullEntry.name, sex: fullEntry.sex, items: fullEntry.nicks } : null;
    const asNick = EN_FULL_BY_NICK.get(q) || [];

    let suggestions = [];
    if (!asFull && asNick.length === 0 && q.length >= 2) {
        const prefix = [];
        const substr = [];
        for (const entry of EN_NICK_SEARCH_INDEX) {
            if (entry.lower.startsWith(q)) prefix.push({ name: entry.name, sex: entry.sex });
            else if (entry.lower.includes(q)) substr.push({ name: entry.name, sex: entry.sex });
        }
        suggestions = [...prefix, ...substr].slice(0, 24);
    }

    return { query, isEmpty: false, asFull, asNick, suggestions };
}

const NAMING_MODES = {
    kr: [
        { key: 'modern_f', short: '요즘', sex: 'f', title: '요즘 여자 이름 (성+이름)' },
        { key: 'modern_m', short: '요즘', sex: 'm', title: '요즘 남자 이름 (성+이름)' },
        { key: 'retro_f', short: '옛날', sex: 'f', title: '옛날 여자 이름 (성+이름)' },
        { key: 'retro_m', short: '옛날', sex: 'm', title: '옛날 남자 이름 (성+이름)' },
        { key: 'period_f', short: '시대물', sex: 'f', title: '시대물 여자 이름 (이름만)' },
        { key: 'period_m', short: '시대물', sex: 'm', title: '시대물 남자 이름 (이름만)' },
    ],
    en: [
        { key: 'female', short: '여자', sex: 'f', title: '여자 이름' },
        { key: 'male', short: '남자', sex: 'm', title: '남자 이름' },
        { key: 'surname', label: 'Family Name', title: '성 (Family Name)' },
        { key: 'nickname', label: '애칭', title: '영어 이름 ↔ 애칭 양방향 검색' },
    ],
};

const MAX_NAMING_HISTORY = 40;
const MAX_NAMING_HISTORY_LINES = 4;

let _namingState = {
    lang: 'kr',      // 'kr' | 'en'
    subMode: 'modern_f',
    lastSubMode: { kr: 'modern_f', en: 'female' },
    currentName: '',
    nicknameQuery: '',
    history: [],     // 최근 생성된 이름 히스토리 (최대 4줄 표시분 보관)
};

function randomInt(max) {
    if (max <= 1) return 0;
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        const limit = Math.floor(0x100000000 / max) * max;
        let x;
        do {
            crypto.getRandomValues(buf);
            x = buf[0];
        } while (x >= limit);
        return x % max;
    }
    return Math.floor(Math.random() * max);
}

function pickFromPool(pool, excludeSet) {
    if (!pool.length) return '';
    for (let attempt = 0; attempt < 10; attempt++) {
        const cand = pool[randomInt(pool.length)];
        if (!excludeSet || !excludeSet.has(cand)) return cand;
    }
    return pool[randomInt(pool.length)];
}

// 한국어 풀네임 길이 가중치: 3글자 94% / 2글자(외자 이름) 3% / 4글자(복성·3글자 이름) 3%
function rollKrFullNameLength() {
    const r = randomInt(100);
    if (r < 94) return 3;
    if (r < 97) return 2;
    return 4;
}

function buildKoreanCandidate(pool) {
    if (pool.givenOnly) {
        if (pool.given1.length && randomInt(100) < 5) {
            return pool.given1[randomInt(pool.given1.length)];
        }
        return pool.given2[randomInt(pool.given2.length)];
    }
    const targetLen = rollKrFullNameLength();
    if (targetLen === 2 && pool.given1.length) {
        for (let i = 0; i < 6; i++) {
            const surname = pool.surnames1[randomInt(pool.surnames1.length)];
            const given = pool.given1[randomInt(pool.given1.length)];
            if (surname !== given) return `${surname}${given}`;
        }
    }
    if (targetLen === 4) {
        if (pool.given3.length && randomInt(100) < 30) {
            for (let i = 0; i < 6; i++) {
                const surname = pool.surnames1[randomInt(pool.surnames1.length)];
                const given = pool.given3[randomInt(pool.given3.length)];
                if (given[0] !== surname) return `${surname}${given}`;
            }
        }
        if (pool.surnames2.length && pool.given2.length) {
            for (let i = 0; i < 6; i++) {
                const surname = pool.surnames2[randomInt(pool.surnames2.length)];
                const given = pool.given2[randomInt(pool.given2.length)];
                if (surname !== given) return `${surname}${given}`;
            }
        }
    }
    const surname = pool.surnames1[randomInt(pool.surnames1.length)];
    const given = pool.given2[randomInt(pool.given2.length)];
    return `${surname}${given}`;
}

/**
 * 지정한 언어·카테고리로 랜덤 이름을 즉시 생성 (AI 호출 없음).
 * @param {'kr'|'en'} lang
 * @param {string} subMode
 * @param {string[]} recentList 최근 중복 회피용 목록
 */
function generateName(lang = _namingState.lang, subMode = _namingState.subMode, recentList = []) {
    const exclude = new Set(recentList);
    if (lang === 'kr') {
        const modeKey = normalizeSubMode('kr', subMode);
        const pool = KR_POOLS[modeKey] || KR_POOLS.modern_f;
        for (let attempt = 0; attempt < 16; attempt++) {
            const full = buildKoreanCandidate(pool);
            if (!exclude.has(full)) return full;
        }
        return buildKoreanCandidate(pool);
    }
    if (subMode === 'surname') return pickFromPool(POOLS.enSurname, exclude);
    if (subMode === 'male') return pickFromPool(POOLS.enMale, exclude);
    return pickFromPool(POOLS.enFemale, exclude);
}

function normalizeSubMode(lang, subMode) {
    if (lang === 'kr') {
        if (subMode === 'female') return 'modern_f';
        if (subMode === 'male') return 'modern_m';
    } else if (lang === 'en') {
        if (typeof subMode === 'string' && subMode.endsWith('_f')) return 'female';
        if (typeof subMode === 'string' && subMode.endsWith('_m')) return 'male';
    }
    const valid = NAMING_MODES[lang]?.some(m => m.key === subMode);
    return valid ? subMode : NAMING_MODES[lang][0].key;
}

function openNamingPanel(forceOpen = false) {
    if (document.getElementById(PANEL_ID)) {
        closePanel(PANEL_ID);
        if (!forceOpen) return;
    }

    const panel = createPanel(PANEL_ID);
    const body = getPanelBody(panel);
    body.style.textAlign = 'center';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:10px;display:flex;align-items:center;justify-content:center;font-size:13px;letter-spacing:-0.2px;';
    title.innerHTML = '<span><i class="fa-solid fa-signature" style="margin-right:6px;color:var(--SmartThemeQuoteColor, var(--ws-text2));"></i>랜덤 이름 생성기</span>';
    body.appendChild(title);

    // 대분류 탭: 한국어 이름 | 영어 이름
    const langTabs = document.createElement('div');
    langTabs.className = 'ws-naming-tabs';
    body.appendChild(langTabs);

    // 세부 카테고리 버튼 행
    const subTabs = document.createElement('div');
    subTabs.className = 'ws-naming-subtabs';
    body.appendChild(subTabs);

    // 생성기 영역 (결과 카드 + 생성 버튼 + 최근 생성 기록)
    const genView = document.createElement('div');
    body.appendChild(genView);

    // 결과 카드 (클릭 시 즉시 복사)
    const resultCard = document.createElement('div');
    resultCard.className = 'ws-naming-card';
    resultCard.title = '클릭하면 클립보드에 복사됩니다';

    const nameEl = document.createElement('div');
    nameEl.className = 'ws-naming-result';

    const hintEl = document.createElement('div');
    hintEl.className = 'ws-naming-hint';
    hintEl.textContent = '탭하여 복사';

    resultCard.appendChild(nameEl);
    resultCard.appendChild(hintEl);
    genView.appendChild(resultCard);

    // 주 액션 버튼 행: [생성]
    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;margin-top:10px;';

    const genBtn = document.createElement('button');
    genBtn.className = 'ws-btn ws-btn-accent ws-naming-gen-btn';
    genBtn.innerHTML = '<i class="fa-solid fa-feather-pointed" style="margin-right:6px;"></i>생성';

    actionRow.appendChild(genBtn);
    genView.appendChild(actionRow);

    // 최근 생성 기록 칩 영역
    const histSection = document.createElement('div');
    histSection.className = 'ws-naming-history';
    genView.appendChild(histSection);

    // 영어 애칭 양방향 검색 영역
    const nickWrap = document.createElement('div');
    nickWrap.className = 'ws-naming-nick-wrap';
    nickWrap.style.display = 'none';

    const nickSearchRow = document.createElement('div');
    nickSearchRow.className = 'ws-naming-nick-search';

    const nickInput = document.createElement('input');
    nickInput.type = 'text';
    nickInput.className = 'ws-input ws-naming-nick-input';
    nickInput.placeholder = '영문 이름 또는 애칭 양방향 검색';
    nickInput.autocomplete = 'off';
    nickInput.spellcheck = false;

    const nickClearBtn = document.createElement('button');
    nickClearBtn.type = 'button';
    nickClearBtn.className = 'ws-btn ws-naming-nick-clear';
    nickClearBtn.title = '검색어 지우기';
    nickClearBtn.setAttribute('aria-label', '검색어 지우기');
    nickClearBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

    nickSearchRow.appendChild(nickInput);
    nickSearchRow.appendChild(nickClearBtn);

    const nickResults = document.createElement('div');
    nickResults.className = 'ws-naming-nick-results ws-thin-scroll';

    nickWrap.appendChild(nickSearchRow);
    nickWrap.appendChild(nickResults);
    body.appendChild(nickWrap);

    function appendSexIcon(parent, sex) {
        if (sex !== 'f' && sex !== 'm') return;
        const icon = document.createElement('i');
        icon.className = sex === 'f' ? 'fa-solid fa-venus ws-naming-sex-f' : 'fa-solid fa-mars ws-naming-sex-m';
        icon.setAttribute('aria-hidden', 'true');
        parent.appendChild(icon);
    }

    let copyFeedbackTimer = null;
    function showCopiedFeedback() {
        if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
        hintEl.textContent = '복사됨 ✓';
        hintEl.classList.add('is-copied');
        copyFeedbackTimer = setTimeout(() => {
            hintEl.textContent = '탭하여 복사';
            hintEl.classList.remove('is-copied');
        }, 900);
    }

    function flashNamePop() {
        nameEl.classList.remove('is-popping');
        // 동일 프레임 재트리거를 위해 reflow 유도
        void nameEl.offsetWidth;
        nameEl.classList.add('is-popping');
    }

    function pushHistory(name) {
        if (!name) return;
        const filtered = _namingState.history.filter(n => n !== name);
        filtered.unshift(name);
        _namingState.history = filtered.slice(0, MAX_NAMING_HISTORY);
    }

    function renderResultOnly(animate = false) {
        nameEl.textContent = _namingState.currentName || '—';
        if (animate) flashNamePop();
        renderHistory();
    }

    function renderHistory() {
        histSection.innerHTML = '';
        const past = _namingState.history.slice(1);
        if (!past.length) return;
        const label = document.createElement('div');
        label.className = 'ws-naming-hist-label';

        const labelText = document.createElement('span');
        labelText.textContent = '방금 나온 이름';

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'ws-naming-hist-clear';
        clearBtn.title = '방금 나온 이름 캐시 비우기';
        clearBtn.setAttribute('aria-label', '방금 나온 이름 캐시 비우기');
        clearBtn.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>비우기</span>';
        clearBtn.addEventListener('click', () => {
            _namingState.history = [];
            renderHistory();
        });

        label.appendChild(labelText);
        label.appendChild(clearBtn);
        histSection.appendChild(label);

        const chips = document.createElement('div');
        chips.className = 'ws-naming-chips';
        histSection.appendChild(chips);

        const canMeasure = chips.offsetWidth > 0;
        const itemsToRender = canMeasure ? past : past.slice(0, 20);
        const frag = document.createDocumentFragment();
        const appended = [];

        for (const item of itemsToRender) {
            const chip = document.createElement('button');
            chip.className = 'ws-btn ws-naming-chip';
            chip.textContent = item;
            chip.title = '클릭해 선택 및 복사';
            chip.addEventListener('click', async () => {
                _namingState.currentName = item;
                pushHistory(item);
                renderResultOnly(true);
                const ok = await copyText(item, false);
                if (ok) showCopiedFeedback();
            });
            frag.appendChild(chip);
            appended.push(chip);
        }
        chips.appendChild(frag);

        if (canMeasure) {
            const rowTops = [];
            let cutIndex = -1;
            for (let i = 0; i < appended.length; i++) {
                const top = appended[i].offsetTop;
                const lastTop = rowTops[rowTops.length - 1];
                if (rowTops.length === 0 || Math.abs(top - lastTop) > 4) {
                    rowTops.push(top);
                }
                if (rowTops.length > MAX_NAMING_HISTORY_LINES) {
                    cutIndex = i;
                    break;
                }
            }
            if (cutIndex >= 0) {
                for (let i = cutIndex; i < appended.length; i++) appended[i].remove();
            }
        }
    }

    function isNicknameMode() {
        return _namingState.lang === 'en' && _namingState.subMode === 'nickname';
    }

    function appendNickChipGroup(titleText, items, headerSex = '') {
        if (!items.length) return;
        const group = document.createElement('div');

        const header = document.createElement('div');
        header.className = 'ws-naming-nick-group-title';
        const headerText = document.createElement('span');
        headerText.textContent = titleText;
        header.appendChild(headerText);
        if (headerSex) {
            header.appendChild(document.createTextNode(' '));
            appendSexIcon(header, headerSex);
        }
        group.appendChild(header);

        const chips = document.createElement('div');
        chips.className = 'ws-naming-chips';
        const frag = document.createDocumentFragment();

        for (const item of items) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ws-btn ws-naming-chip ws-naming-nick-chip';
            const label = document.createElement('span');
            label.textContent = item.name;
            chip.appendChild(label);
            if (item.sex) appendSexIcon(chip, item.sex);

            chip.title = `'${item.name}' 검색`;
            chip.addEventListener('click', () => {
                _namingState.nicknameQuery = item.name;
                renderNicknameResults();
                nickInput.focus();
            });
            frag.appendChild(chip);
        }

        chips.appendChild(frag);
        group.appendChild(chips);
        nickResults.appendChild(group);
    }

    function renderNicknameEmpty(messageLines) {
        const empty = document.createElement('div');
        empty.className = 'ws-naming-nick-empty';
        messageLines.forEach((line, idx) => {
            if (idx > 0) empty.appendChild(document.createElement('br'));
            empty.appendChild(document.createTextNode(line));
        });
        nickResults.appendChild(empty);
    }

    function renderNicknameResults() {
        if (nickInput.value !== _namingState.nicknameQuery) {
            nickInput.value = _namingState.nicknameQuery;
        }
        const res = lookupEnglishNicknames(_namingState.nicknameQuery);
        nickClearBtn.style.display = res.isEmpty ? 'none' : '';
        nickResults.innerHTML = '';

        if (res.isEmpty) {
            renderNicknameEmpty([
                '본명을 넣으면 애칭이, 애칭을 넣으면 본명이 나옵니다.',
                '영어 여자·남자 탭에서 바로 넘어오면 이름이 자동 입력됩니다.',
            ]);
            return;
        }

        if (res.asFull || res.asNick.length) {
            if (res.asFull) {
                appendNickChipGroup(
                    `${res.asFull.name}의 애칭 (본명 → 애칭)`,
                    res.asFull.items.map(name => ({ name, sex: '' })),
                    res.asFull.sex
                );
            }
            if (res.asNick.length) {
                appendNickChipGroup(
                    `${res.query}을(를) 애칭으로 쓰는 본명 (애칭 → 본명)`,
                    res.asNick
                );
            }
            return;
        }

        if (res.suggestions.length) {
            appendNickChipGroup('비슷한 이름 (클릭해 검색)', res.suggestions);
            return;
        }

        renderNicknameEmpty([
            `'${res.query}'에 등록된 영어 애칭 데이터가 없습니다.`,
            '다른 철자나 이름을 입력해 보세요.',
        ]);
    }

    function syncViewMode() {
        const nickMode = isNicknameMode();
        genView.style.display = nickMode ? 'none' : '';
        nickWrap.style.display = nickMode ? '' : 'none';
        if (nickMode) renderNicknameResults();
    }

    function rollNewName() {
        _namingState.subMode = normalizeSubMode(_namingState.lang, _namingState.subMode);
        const recent = [_namingState.currentName, ..._namingState.history].filter(Boolean);
        const next = generateName(_namingState.lang, _namingState.subMode, recent);
        _namingState.currentName = next;
        pushHistory(next);
        renderResultOnly(true);
    }

    function renderTabs() {
        _namingState.subMode = normalizeSubMode(_namingState.lang, _namingState.subMode);
        _namingState.lastSubMode[_namingState.lang] = _namingState.subMode;

        langTabs.innerHTML = '';
        [
            { key: 'kr', label: '한국어 이름' },
            { key: 'en', label: '영어 이름' },
        ].forEach(({ key, label }) => {
            const b = document.createElement('button');
            b.className = 'ws-btn' + (_namingState.lang === key ? ' ws-btn-accent' : '');
            b.textContent = label;
            b.addEventListener('click', () => {
                if (_namingState.lang === key) return;
                _namingState.lang = key;
                _namingState.subMode = normalizeSubMode(key, _namingState.lastSubMode[key]);
                renderTabs();
                syncViewMode();
                if (isNicknameMode()) {
                    requestAnimationFrame(() => { try { nickInput.focus(); } catch { } });
                } else {
                    rollNewName();
                }
            });
            langTabs.appendChild(b);
        });

        subTabs.innerHTML = '';
        subTabs.classList.toggle('is-kr', _namingState.lang === 'kr');
        NAMING_MODES[_namingState.lang].forEach(mode => {
            const b = document.createElement('button');
            b.className = 'ws-btn' + (_namingState.subMode === mode.key ? ' ws-btn-accent' : '');
            if (mode.sex) {
                const sp = document.createElement('span');
                sp.textContent = mode.short;
                b.appendChild(sp);
                appendSexIcon(b, mode.sex);
                b.title = mode.title;
                b.setAttribute('aria-label', mode.title);
            } else {
                b.textContent = mode.label;
                if (mode.title) b.title = mode.title;
            }
            b.addEventListener('click', () => {
                const prevMode = _namingState.subMode;
                const isAlreadyNick = prevMode === 'nickname' && mode.key === 'nickname';
                // 영어 여자·남자 탭에서 애칭 탭으로 이동 시 현재 패널 이름을 검색어로 자동 전달 (Family Name 제외)
                if (mode.key === 'nickname' && !isAlreadyNick && (prevMode === 'female' || prevMode === 'male') && _namingState.currentName) {
                    _namingState.nicknameQuery = _namingState.currentName;
                }
                _namingState.subMode = mode.key;
                _namingState.lastSubMode[_namingState.lang] = mode.key;
                renderTabs();
                syncViewMode();
                if (mode.key === 'nickname') {
                    if (!isAlreadyNick) {
                        requestAnimationFrame(() => { try { nickInput.focus(); } catch { } });
                    }
                } else {
                    rollNewName();
                }
            });
            subTabs.appendChild(b);
        });
    }

    async function copyCurrent() {
        if (!_namingState.currentName) return;
        const ok = await copyText(_namingState.currentName, false);
        if (ok) showCopiedFeedback();
    }

    resultCard.addEventListener('click', copyCurrent);
    genBtn.addEventListener('click', () => {
        rollNewName();
    });
    nickInput.addEventListener('input', () => {
        _namingState.nicknameQuery = nickInput.value;
        renderNicknameResults();
    });
    nickClearBtn.addEventListener('click', () => {
        _namingState.nicknameQuery = '';
        nickInput.value = '';
        renderNicknameResults();
        nickInput.focus();
    });

    renderTabs();
    syncViewMode();
    if (isNicknameMode()) {
        requestAnimationFrame(() => { try { nickInput.focus(); } catch { } });
    } else {
        if (!_namingState.currentName) rollNewName();
        else renderResultOnly(false);
        requestAnimationFrame(() => { try { genBtn.focus(); } catch { } });
    }
}

export function registerNamingCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'naming',
        helpString: 'Open offline random name generator (Korean / English). Usage: /naming [kr|en]',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Language (kr or en, optional)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: (_a, value) => {
            const arg = String(value ?? '').trim().toLowerCase();
            let hasLangArg = false;
            if (arg === 'en' || arg === 'eng' || arg === 'english' || arg === '영어') {
                _namingState.lang = 'en';
                _namingState.subMode = normalizeSubMode('en', _namingState.lastSubMode.en || _namingState.subMode);
                _namingState.currentName = '';
                hasLangArg = true;
            } else if (arg === 'kr' || arg === 'ko' || arg === 'kor' || arg === 'korean' || arg === '한국어') {
                _namingState.lang = 'kr';
                _namingState.subMode = normalizeSubMode('kr', _namingState.lastSubMode.kr || _namingState.subMode);
                _namingState.currentName = '';
                hasLangArg = true;
            }
            openNamingPanel(hasLangArg);
            return '';
        },
    }));
}
