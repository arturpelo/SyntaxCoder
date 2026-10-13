# SyntaxCoder

Asystent kodu w VS Code (w stylu Claude Code) podłączony do **LM Studio**. Czat, pliki, foldery i terminal.

Ikona **robota** na lewym pasku aktywności otwiera okno czatu.

## Instalacja z VSIX

1. `Extensions` → `…` → **Install from VSIX…**
2. Wskaż plik `syntaxcoder-0.1.0.vsix` (jest w repozytorium)
3. Kliknij robota po lewej — otworzy się czat SyntaxCoder

## LM Studio

Należy mieć zainstalowany i uruchomiony **LM Studio** (https://lmstudio.ai/). W ustawieniach LM Studio włącz **Allow remote connections** i sprawdź host oraz port.
Pobierz model np. `qwen3.6-35b-a3b` i uruchom go w LM Studio. Jeśli wszystko jest poprawnie skonfigurowane, w panelu czatu SyntaxCoder pojawi się komunikat `Connected to LM Studio` i jeśli modeli jest więcj niż jeden, to będzie można wybrać model z listy rozwijanej.

W panelu czatu kliknij **Połączenie** i wpisz host oraz port (np. `192.168.1.20` i `1234`).

Ustawienia (`Ctrl+,` → SyntaxCoder): `syntaxcoder.host`, `syntaxcoder.port`.

## Komendy palety

- `SyntaxCoder: Otwórz czat`
- `SyntaxCoder: Nowa rozmowa`
- `SyntaxCoder: Zatrzymaj`
- `SyntaxCoder: Wybierz model LM Studio`
