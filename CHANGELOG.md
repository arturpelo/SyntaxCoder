# Changelog

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
