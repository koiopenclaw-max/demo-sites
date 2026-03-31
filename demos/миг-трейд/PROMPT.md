# Миг Трейд — Продуктови страници

## Задача
Създай отделни HTML страници за всеки вид продукт на Миг Трейд. Прехвърли ЦЕЛИЯ текст, снимки, цени и описания от стария сайт (scraped-content.txt) в новия дизайн.

## Текущ сайт
`template.html` е главната страница (index.html) — ползвай СЪЩИЯ дизайн, шрифтове, цветова схема, CSS стил. Dark premium тема.

## Продуктови категории — създай ОТДЕЛЕН HTML файл за всяка:

### 1. `metalni-vrati.html` — Метални врати за апартаменти
Всички видове врати с описания, цени и снимки:
- Метална врата с цяла каса — 495 лв
- Двупластова с декоративно фолио — 415 лв
- Двупластова с две брави — 395 лв
- Двупластова с една брава — 365 лв
- Еднопластова с две брави — 265 лв
- Еднопластова с касова брава — 230 лв
- Еднопластова със секретна брава и бронировка — 230 лв
- Еднопластова със секретна брава — 170 лв
- Еднопластова за мазета — цена по запитване

Снимки (от стария сайт — използвай директно URL-ите):
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-s-cqla-kasa1.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-s-cqla-kasa2.jpg
- https://mig-trade.com/images/metalni-vrati/metaln-vrata-s-folio.jpg
- https://mig-trade.com/images/metalni-vrati/metaln-vrata-s-folio2.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-s-dve-bravi.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-s-dve-bravi1.jpg
- https://mig-trade.com/images/metalni-vrati/dvuplastova-metalna-vrata-s-edna-brava.jpg
- https://mig-trade.com/images/metalni-vrati/ednoplastova-metalna-vrata-s-dve-bravi.jpg
- https://mig-trade.com/images/metalni-vrati/ednoplastova-metalna-vrata-kasova-brava.jpg
- https://mig-trade.com/images/metalni-vrati/ednoplastova-metalna-vrata-sekreten-patron-bronirovka.jpg
- https://mig-trade.com/images/metalni-vrati/ednoplastova-metalna-vrata-sekretna-brava.jpg
- https://mig-trade.com/images/metalni-vrati/ednoplastova-vrata-za-maze.jpg

### 2. `vhodni-vrati.html` — Входни метални врати за блокове
Врати с пощенски кутии за вход на блок:
- Крило с пощенски кутии
- Входна врата с 24 пощенски кутии
- Входна врата с 48 пощенски кутии
- Врати за офис сгради с пощенски кутии

Снимки:
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-vhod-kutii.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-vhod-kutii1.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-vhod-24kutii.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-vhod-s-kutii.jpg
- https://mig-trade.com/images/metalni-vrati/metalna-vrata-ofis-vhod-s-kutii1.jpg

### 3. `metalni-reshetki.html` — Метални решетки
Видове решетки с цени:
- 12x12x1.5мм — 35 лв/м² (за прозорци)
- 15x15x1.5мм — 40 лв/м² (за тераси и прозорци)
- 20x20x1.5мм — 45 лв/м² (за складове, офиси)
- Решетки за врати — 200 лв (стандартен размер 1x2м)
- Безплатна доставка и монтаж!

Снимки:
- https://mig-trade.com/images/metalni-reshetki/img_1347.jpg
- https://mig-trade.com/images/metalni-reshetki/img_1348.jpg
- https://mig-trade.com/images/metalni-reshetki/img_1475.jpg
- https://mig-trade.com/images/metalni-reshetki/p1000509.jpg
- https://mig-trade.com/images/metalni-reshetki/p1000547.jpg
- https://mig-trade.com/images/metalni-reshetki/p1000557.jpg

### 4. `ogradi-portali.html` — Огради и портали
По-малко съдържание от стария сайт. Направи страница с:
- Описание на услугата (метални огради, портали, парапети)
- CTA за заявка
- Контакти

## Обновяване на index.html
- Навигацията трябва да включва линкове към ВСИЧКИ нови страници
- Добави секция "Нашите продукти" с карти, водещи към всяка продуктова страница
- Всяка карта: заглавие, кратко описание, "от Х лв" цена, линк

## Обновяване на навигацията във ВСИЧКИ файлове
Всеки HTML файл трябва да има ЕДНАКВА навигация:
- Начало (index.html)
- Метални врати (metalni-vrati.html)
- Входни врати (vhodni-vrati.html)
- Метални решетки (metalni-reshetki.html)
- Огради и портали (ogradi-portali.html)
- Контакти (секция в index.html)

## Дизайн правила
- Ползвай СЪЩИЯ CSS стил от template.html — dark тема, gold accent (#C9A96E)
- Споделеният CSS може да е inline в <style> на всеки файл (не external CSS)
- Mobile-first, responsive
- Всяка страница: header с навигация + hero за категорията + продукти с описания/снимки/цени + CTA бутон "Заявка за оглед" + footer с контакти
- Снимките от стария сайт ползвай с пълни URL-ове (https://mig-trade.com/images/...)

## SEO
- Уникален <title> и <meta description> за всяка страница — фокус върху продукта и "София"
- Schema.org Product за всеки продукт (name, description, price, image, brand: Миг Трейд)
- Schema.org LocalBusiness в index.html
- Хединги (h1, h2, h3) — ясна йерархия, ключови думи

## Контактни данни (за всички страници)
- Фирма: Миг Трейд ЕООД
- БУЛСТАТ: BG175437805
- GSM: 0878243810, 0878243812, 0898788957
- Район: София и София област
- Срок: до 5 работни дни

## Файлове за създаване:
1. `index.html` — обновен с навигация + продуктови карти
2. `metalni-vrati.html` — метални врати за апартаменти
3. `vhodni-vrati.html` — входни врати за блокове
4. `metalni-reshetki.html` — метални решетки
5. `ogradi-portali.html` — огради и портали

## ВАЖНО
- Прехвърли ЦЕЛИЯ текст от стария сайт (scraped-content.txt) — не съкращавай
- Всички цени трябва да са точни (от стария сайт)
- Снимките да са от стария сайт (direct URL hotlink)
- Всяка страница е self-contained (inline CSS, не external)

When completely finished, run this command to notify me:
openclaw system event --text "Done: Миг Трейд product pages (5 files)" --mode now
