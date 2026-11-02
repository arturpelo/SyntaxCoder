# Changelog

## 0.32.0

- `edit_file` działa w plikach z końcami linii Windows (CRLF). Model pisze `old_string` z samym `\n`, więc każda wielolinijkowa zmiana w takim pliku kończyła się „old_string not found”, a agent ponawiał próby, aż wyczerpał rundy. Teraz w pliku z samymi końcami CRLF dopasowanie idzie na wersji z `\n`, a zapis wraca do CRLF. Plik z mieszanymi końcami linii jest dopasowywany dosłownie, jak dotąd.
- Limit rund narzędzi to nowe ustawienie `syntaxcoder.maxTurns`, domyślnie 100 (było na stałe 24), zakres 5–1000. Kręcenie się w kółko nadal przerywa pracę wcześniej.
- Wskaźnik generowania pokazuje tokeny zamiast sekund. Gdy model pisze argumenty narzędzia, widać rosnącą liczbę, np. `write_file ~640 tok`. LM Studio oddaje te argumenty dopiero w całości (sprawdzone: `/v1/chat/completions`, `/v1/responses`, `/api/v1/chat`), więc `~` to szacunek ze zmierzonego tempa modelu, a na końcu wskaźnik pokazuje dokładną liczbę z LM Studio.
- Tempo do szacunku jest pamiętane osobno dla każdego modelu, który naprawdę odpowiada (także przy pustym `syntaxcoder.model`), i odświeżane w każdej turze. Nowy model pokazuje `write_file …`, dopóki jego tempo nie zostanie zmierzone.
- Dopóki LM Studio nic nie wysyła, wskaźnik pokazuje `prompt…`. Koniec bez tempa to sama liczba tokenów, np. `192 tok`. Sekundy są w podpowiedzi.

## 0.31.1

- Wskaźnik generowania pokazuje prawdziwe liczby. Wcześniej liczył zdarzenia ze strumienia, a LM Studio wysyła argumenty narzędzia jednym kawałkiem na końcu: tura z 38 tokenami pokazywała „2 tok”, a tempo z dwóch zdarzeń wychodziło zawyżone.
- Dopóki LM Studio nic nie wysyła (przetwarza prompt albo pisze wywołanie narzędzia), wskaźnik pokazuje `czeka 4.1 s` zamiast „prompt”, który obejmował też ciche pisanie wywołania.
- Gdy model pisze argumenty narzędzia, wskaźnik pokazuje nazwę narzędzia i czas, np. `write_file 12 s`, bez udawanego licznika.
- Tempo jest liczone tylko z tokenów przesłanych na bieżąco i tylko przy co najmniej 20 tokenach. Po odpowiedzi liczba tokenów zawsze pochodzi z LM Studio; bez tempa wskaźnik pokazuje całkowity czas zapytania, np. `26 tok · 4.4 s`. Stop albo błąd chowa wskaźnik.
- Wskaźnik stoi za licznikiem kontekstu: najpierw kontekst, potem tokeny.

## 0.31.0

- Wskaźnik generowania obok nazwy modelu. Gdy model przetwarza prompt (LM Studio nic wtedy nie wysyła), pokazuje czas, np. `prompt 12 s`, odświeżany co sekundę. Potem tokeny i tempo na żywo, np. `523 tok · 52 tok/s`, do 4 razy na sekundę. Liczą się tokeny tekstu, myślenia i argumentów narzędzi, także w rundach recenzenta.
- Po odpowiedzi wskaźnik pokazuje dokładną liczbę tokenów z serwera, a podpowiedź mówi, po ilu sekundach przyszedł pierwszy token (czas przetwarzania promptu). Stop albo błąd przed pierwszym tokenem chowa wskaźnik. **Nowa rozmowa** go czyści.
- Ikona rozszerzenia ma zieloną ramkę zamiast niebieskiej.

## 0.30.0

- Suwak **Myślenie** za nazwą modelu: poziom myślenia modelu. Pozycje suwaka to poziomy, które LM Studio podaje dla wybranego modelu (`capabilities.reasoning` w `/api/v1/models`), np. Qwen3.6 ma wył./wł., a Qwen3.8 wył., niskie, średnie, bardzo wysokie i wł. Zmiana modelu przestawia suwak na poziomy nowego modelu.
- Model bez poziomów myślenia (np. Qwen3 Coder) i serwer bez `/api/v1` nie mają suwaka i nie dostają parametru.
- Wybór trafia do modelu jako `reasoning_effort` (wył. = `none`, wł. = domyślne myślenie modelu) i działa od następnego zapytania, także w trakcie zadania. Wartości spoza listy OpenAI nie są wysyłane, więc serwer nie odpowie błędem 400. Podpowiedzi Inline go nie dostają.
- Nowe ustawienie `syntaxcoder.reasoning`. Poziom, którego wybrany model nie ma, oznacza jego ustawienie domyślne; po powrocie do modelu, który go ma, suwak wraca do tego poziomu.
- Licznik kontekstu bierze rozmiar kontekstu z `/api/v1/models` (starsze LM Studio: `/api/v0/models`). Dane modelu są pamiętane przez minutę.

## 0.21.0

- Długie zadania nie kończą się już błędem `terminated`. LM Studio nic nie wysyła, dopóki nie przetworzy całego promptu, a `fetch` w Node zrywał odpowiedź po 5 minutach ciszy. Czat łączy się teraz przez `http`/`https` bez limitu ciszy. Przerwać odpowiedź może tylko **Stop**.
- Zerwana w połowie odpowiedź ma czytelny komunikat z powodem, np. „Serwer przerwał odpowiedź (aborted). Sprawdź log LM Studio…”, zamiast samego `terminated`.
- Długie wyniki narzędzi (ponad 2000 znaków, np. całe pliki) z poprzednich zadań zostają w historii tylko jako krótka notka. Wcześniej każde kolejne pytanie wysyłało je od nowa, a LM Studio przetwarzało taki prompt minutami. Agent przeczyta plik ponownie, gdy go potrzebuje.
- Licznik kontekstu obok nazwy modelu, np. `85.2k / 262k`: tokeny ostatniego zapytania rozmowy (`usage` z LM Studio) i rozmiar kontekstu załadowanego modelu (`/api/v0/models`). Powyżej 3/4 kontekstu licznik zmienia kolor. **Nowa rozmowa** go zeruje.
- Tabele markdown w odpowiedziach wyświetlają się jako tabele, a nie surowe znaki `|`. Szeroka tabela przewija się w bok.

## 0.20.0

Poprawki z przeglądu kodu (code review) wydań 0.9.0–0.10.0:

- Nieudane podsumowanie agenta (np. przepełniony kontekst po limicie rund, błąd sieci) nie kasuje już historii zadania. Czat dostaje błąd, a praca zostaje w rozmowie.
- Prośba o podsumowanie nie tworzy dwóch wiadomości użytkownika pod rząd, których część modeli nie przyjmuje (np. Gemma, Mistral). Polecenie „przestań pracować” nie zostaje w historii, więc nie trafia do następnego zadania.
- Podpowiedzi rozpoznają komentarze według języka. W Pythonie `//` to dzielenie, a nie komentarz. `#` jest komentarzem w Pythonie, Ruby, powłoce, YAML i innych, a `--` w SQL, Lua i Haskellu. Napisy w potrójnych cudzysłowach mogą mieć wiele linii. Wcześniej np. `(lo + hi // 2)` kasował całą podpowiedź.
- Włączenie przełącznika **Web** pokazuje ostrzeżenie z listą serwerów: zapytania wychodzą poza Twoją sieć i mogą zawierać fragmenty kodu. Web włącza się dopiero po potwierdzeniu.
- Web: martwy albo wolny serwer MCP nie spowalnia pracy. Zadanie czeka na łączące się serwery najwyżej 4 s, nieudane połączenie jest pamiętane przez 5 minut i zgłaszane raz, a wywołanie narzędzia trafia od razu do właściwego serwera.
- Web: Stop zadania nie przerywa wspólnego połączenia z serwerem.
- Web: błąd narzędzia albo złe argumenty od modelu nie porzucają działającej sesji. Po wygaśnięciu sesji (HTTP 404) rozszerzenie łączy się raz od nowa i ponawia wywołanie. Porzucana sesja jest zamykana.
- Web: odpowiedź serwera jest czytana do 4 MB. Odpowiedź SSE kończy się, gdy tylko przyjdzie wynik, także wtedy, gdy serwer nie zamyka strumienia.
- Web: dwie nazwy narzędzi, które po oczyszczeniu brzmią tak samo (np. `get.docs` i `get_docs`), dostają różne nazwy dla modelu.
- Wszystkie przełączniki z czatu (`reviewer`, `planMode`, `inlineCompletions`) działają, jak `autonomousMode` i `webTools`, tylko z ustawień użytkownika. Repozytorium nie włączy już podpowiedzi ani nie zablokuje przełącznika.
- Przy pustym `syntaxcoder.model` rozszerzenie pamięta pierwszy model z serwera przez minutę, zamiast pobierać listę modeli przy każdej podpowiedzi.

## 0.10.0

- Przełącznik **Web** (`syntaxcoder.webTools`, domyślnie wyłączony): agent dostaje narzędzia serwerów MCP po HTTP z `syntaxcoder.mcpServers`. Domyślnie to context7 (dokumentacja bibliotek), grep.app (kod na GitHubie) i DeepWiki (dokumentacja repozytoriów). Agent woła je bez pytania. Wyniki trafiają do modelu jako dane, nie polecenia. Serwer, który nie odpowiada, wypada z listy z krótką informacją. Oba ustawienia działają tylko z ustawień użytkownika.
- Szturchaniec zamiast twardego stopu. Agent, który kręci się w kółko, najpierw dostaje wskazówkę, co dokładnie się powtarza, potem turę namysłu bez narzędzi, potem drugą wskazówkę. Dopiero na końcu kończy pracę własnym podsumowaniem (co zrobione, co nie, co blokuje) zamiast samego czerwonego błędu. Tak samo kończy się praca po limicie rund narzędzi. Tura z nowym wynikiem obniża poziom szturchania.
- Nowe sygnały kręcenia się w kółko:
  - to samo wywołanie z błędem po raz kolejny;
  - seria nieudanych zmian jednego pliku (wskazówka: przeczytaj plik ponownie, przepisz go `write_file`);
  - zmiana, która nie zmieniła pliku;
  - edycje, które cofają plik do stanu, w którym już był.
- Szturchnięcia i namysł agenta widać w czacie jako szare linie informacyjne.

## 0.9.1

- Podpowiedź kończy się na domkniętym bloku, jak w Copilocie: pętla z podpętlami i ifami przychodzi w całości, do swojego `}`. Model dostaje strumień do 512 tokenów (było 128) i przestaje generować, gdy blok się domknie. Gdy mimo to urwie w środku, podpowiedź kończy się na ostatniej linii bez otwartych nawiasów, więc nigdy nie zostawia niedomkniętego bloku. Nawiasy w napisach i komentarzach się nie liczą.
- Python: koniec bloku wyznacza wcięcie. Podpowiedź kończy się, gdy blok po `:` się zamknie albo gdy kod wyjdzie z bloku, w którym stoi kursor. `elif`, `else`, `except`, `finally` i `case` należą do tego samego bloku. Nagłówek bez ciała (np. urwane `for x in y:`) odpada.
- Gdy model dojdzie do limitu tokenów, ostatnia, niepełna linia odpada.
- W środku linii podpowiedź pojawia się tylko wtedy, gdy za kursorem są same spacje albo nawiasy zamykające (jak w Copilocie). Mniej podpowiedzi w środku słowa i mniej zapytań do serwera.
- Gdy piszesz dokładnie to, co jest w szarym tekście, reszta podpowiedzi zostaje od razu, bez nowego zapytania do modelu.
- Podpowiedź, która powtarza tekst stojący już za kursorem albo kręci się w kółko (ta sama linia 3 razy, fraza typu `foo = foo = foo`), jest odrzucana.
- Kontekst z innych plików (jak w Copilocie): podpowiedź widzi najbardziej podobne fragmenty innych otwartych plików w tym samym języku (C razem z C++, JS razem z TS), maksymalnie 3 fragmenty i ok. 3000 znaków. Używa ich w formacie repozytorium Qwen-Coder (`<|repo_name|>`, `<|file_sep|>`) razem ze ścieżką bieżącego pliku. Dzięki temu korzysta z funkcji i typów z innych plików zamiast je wymyślać. Wybór fragmentów zmienia się co 40 linii, żeby działała pamięć promptu w LM Studio. Pomiar na M1 Max z Qwen3-Coder-Next: pierwsza podpowiedź w bloku dłuższa o ok. 2 s, kolejne o ok. 0,3 s. Pliki z sekretami są pomijane. Inne szablony FIM (DeepSeek, StarCoder, CodeLlama) dostają tylko bieżący plik.
- Przełącznik **Inline** ma stałą nazwę. Pełna nazwa nie rozwija się już po najechaniu myszą, bo pasek przełączników przy tym skakał. Opis nadal pokazuje dymek.

## 0.9.0

- Podpowiedzi kodu w edytorze: przełącznik **Inline suggestions** przy polu wiadomości (`syntaxcoder.inlineCompletions`). Na pasku widać skrót **Inline**, a pełna nazwa rozwija się po najechaniu myszą. Gdy piszesz, model z LM Studio proponuje dalszy ciąg kodu szarym tekstem, a **Tab** go przyjmuje.
- Zapytanie (`/v1/completions`, fill-in-the-middle) idzie po 300 ms przerwy w pisaniu. Następny klawisz anuluje to zapytanie. Szablon FIM rozszerzenie dobiera po nazwie modelu: Qwen-Coder (domyślny), DeepSeek-Coder, StarCoder albo CodeLlama.
- Początek kontekstu przesuwa się co 40 linii, a nie z każdym klawiszem, więc LM Studio używa zapamiętanego przetworzenia promptu i kolejne podpowiedzi przychodzą szybciej.
- Podpowiedzi biorą model z czatu. Osobny model ustawisz w `syntaxcoder.completionModel` (tylko ustawienia użytkownika). Pliki z sekretami (`.env`, `*.key` itp.) są pomijane. Błąd serwera pokazuje się raz, a nie przy każdym klawiszu.
- Przełączniki (**Auto**, **Recenzent**, **Plan**, **Inline**) są w osobnej linii pod paskiem z modelem, oddzielone kreską.

## 0.8.5

- Plan zadania: nowe narzędzie `update_plan`. Agent zapisuje w nim kroki zadania, a czat pokazuje je jako jedną listę ze stanem kroków (do zrobienia, w toku, zrobione), aktualizowaną na bieżąco.
- Tryb planu: przełącznik **Plan** przy polu wiadomości (`syntaxcoder.planMode`). Agent ma wtedy tylko narzędzia do odczytu, czyta kod i zapisuje plan. Zmiany zaczynają się dopiero po kliknięciu **Wykonaj plan**; nowa wiadomość zamiast tego poprawia plan. Agent, który opisze plan tylko tekstem, dostaje jedno przypomnienie o `update_plan`.
- Recenzent po wykonaniu planu sprawdza każdy krok planu.

## 0.8.0

- Agent nie kręci się w kółko: gdy powtarza to samo wywołanie narzędzia z tym samym wynikiem, dostaje wskazówkę, żeby zmienić podejście. Po 2 takich wskazówkach zostaje zatrzymany z jasnym komunikatem.
- Recenzent: do 4 rund poprawek (było 2). Gdy agent w rundzie poprawek nic nie zmieni, dostaje jeszcze jedną szansę, zanim recenzent sprawdzi pliki ponownie.
- Limit rund narzędzi w jednym zadaniu: 24 (było 16).
- Bezpieczeństwo: `host`, `port`, `https`, `apiKey`, `model` i `commandTimeoutMs` działają tylko z ustawień użytkownika. `.vscode/settings.json` w repozytorium nie przekieruje już połączenia (razem z tokenem API) na inny serwer.
- Bezpieczeństwo: dowiązania symboliczne i junction w projekcie nie pozwalają wyjść poza workspace.
- Bezpieczeństwo: zapis do `.git`, `.vscode`, `.devcontainer` i `.husky` zawsze wymaga zgody, także przy `autoApproveWrites` (hooki gita i zadania VS Code mogą uruchamiać kod).
- Bezpieczeństwo: `read_file` też nie czyta plików z sekretami (wcześniej tylko `grep`).
- `run_command` na Windows po przekroczeniu limitu czasu zamyka całe drzewo procesów, a nie tylko `cmd.exe`.
- `edit_file` wstawia `$&`, `$1` itp. w nowym tekście dosłownie.

## 0.7.0

- Kropka połączenia zmienia się na zieloną dopiero po prawdziwej odpowiedzi API serwera (lista modeli w formacie LM Studio) i gdy serwer ma wybrany model. Wcześniej ustawiony model wystarczał, żeby kropka świeciła na zielono bez pytania serwera. W trakcie sprawdzania kropka pulsuje na żółto.
- Połączenie przez HTTPS: przełącznik **HTTPS** w panelu ustawień (port przechodzi na 443) albo adres `https://…` w polu hosta. Do pracy za reverse proxy.
- Dokładne błędy połączenia: brak dostępu (z prawdziwą przyczyną, np. certyfikat), odpowiedź spoza API (np. strona HTML z proxy), brak wybranego modelu na serwerze.
- Adres IPv6 trafia do URL w nawiasach kwadratowych.

## 0.6.0

- Token API w panelu ustawień czatu, zapisywany w bezpiecznym magazynie VS Code (pęk kluczy systemu). Gdy LM Studio odrzuci token (401/403), panel pokazuje jasny komunikat.
- Panel ustawień pokazuje dokładny błąd połączenia zamiast ogólnego „brak połączenia”.
- Pasek „agent pracuje” przesuwa się o połowę wolniej.

## 0.5.0

- Zmiana języka przyciskiem **Zastosuj** w panelu ustawień: UI przechodzi na wybrany język od razu, nawet gdy VS Code nie zapisze ustawienia (np. przed przeładowaniem okna po instalacji).
- Błędy w obsłudze przycisków czatu pokazują się w czacie zamiast ginąć po cichu.

## 0.4.0

- Nowy wygląd czatu: karty narzędzi z podglądem wyniku, zwijane „myślenie”, bloki kodu z kopiowaniem, pole wiadomości z wyborem modelu i statusem połączenia.
- Dyskretny pasek „agent pracuje” na górnej krawędzi pola wiadomości; stoi, gdy agent czeka na zgodę, i gaśnie po zakończeniu.
- Koniec podwójnych ikon: akcje są tylko na pasku panelu (nowa rozmowa, połączenie).
- `run_command` uruchamia komendę raz (wcześniej szła dwa razy: w terminalu i w tle). Wyjście widać w panelu Output → SyntaxCoder.
- Nowe narzędzia: `get_diagnostics` (błędy z panelu Problems), `move_path`, `delete_path` (do kosza).
- `list_dir`, `glob` i `grep` widzą pliki z kropką (`.github`, `.env.example`); dalej pomijają `.git`, `node_modules` itp.
- Recenzent (`syntaxcoder.reviewer`, przełącznik w czacie): po zmianach sprawdza w plikach, czy polecenie zostało wykonane; braki wracają do agenta (maks. 2 rundy).
- Tryb autonomiczny (`syntaxcoder.autonomousMode`) z przełącznikiem **Auto** w czacie; włączenie wymaga potwierdzenia.
- Rozszerzenie wymaga zaufanego folderu (Workspace Trust). Ustawień zgód nie da się włączyć z ustawień repozytorium.
- `grep` pomija pliki z sekretami (`.env`, `.npmrc`, klucze).
- Języki interfejsu: English, Deutsch, Français, Polski (`syntaxcoder.language`, wybór w panelu ustawień czatu). Prompty i wyniki narzędzi dla modelu są po angielsku.
- Ikona i metadane do VS Code Marketplace.

## 0.2.0

- Panel czatu, narzędzia do plików i terminala, zgody na zapis i komendy.

## 0.1.0

- Pierwsza wersja.
