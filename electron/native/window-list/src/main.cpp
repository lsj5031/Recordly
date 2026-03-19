#include <windows.h>
#include <dwmapi.h>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace {

struct WindowListEntry {
  std::wstring id;
  std::wstring name;
  std::wstring displayId;
  std::wstring appName;
  std::wstring windowTitle;
  RECT bounds{};
};

std::wstring trim(const std::wstring& value) {
  const auto start = value.find_first_not_of(L" \t\r\n");
  if (start == std::wstring::npos) {
    return L"";
  }

  const auto end = value.find_last_not_of(L" \t\r\n");
  return value.substr(start, end - start + 1);
}

std::wstring getWindowTextString(HWND hwnd) {
  const int length = GetWindowTextLengthW(hwnd);
  if (length <= 0) {
    return L"";
  }

  std::wstring buffer(static_cast<size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(hwnd, buffer.data(), length + 1);
  if (copied <= 0) {
    return L"";
  }

  buffer.resize(static_cast<size_t>(copied));
  return trim(buffer);
}

std::wstring getBaseName(const std::wstring& fullPath) {
  const auto separator = fullPath.find_last_of(L"\\/");
  std::wstring fileName = separator == std::wstring::npos
    ? fullPath
    : fullPath.substr(separator + 1);

  const auto extension = fileName.find_last_of(L'.');
  if (extension != std::wstring::npos) {
    fileName = fileName.substr(0, extension);
  }

  return trim(fileName);
}

std::optional<std::wstring> queryVersionString(const std::wstring& filePath, const std::wstring& key) {
  DWORD handle = 0;
  const DWORD versionSize = GetFileVersionInfoSizeW(filePath.c_str(), &handle);
  if (versionSize == 0) {
    return std::nullopt;
  }

  std::vector<BYTE> versionData(versionSize);
  if (!GetFileVersionInfoW(filePath.c_str(), 0, versionSize, versionData.data())) {
    return std::nullopt;
  }

  struct Translation {
    WORD language;
    WORD codePage;
  };

  Translation* translations = nullptr;
  UINT translationBytes = 0;
  if (!VerQueryValueW(versionData.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<LPVOID*>(&translations), &translationBytes)
      || translationBytes < sizeof(Translation)) {
    return std::nullopt;
  }

  const size_t translationCount = translationBytes / sizeof(Translation);
  for (size_t index = 0; index < translationCount; ++index) {
    wchar_t queryPath[256] = {};
    swprintf_s(
      queryPath,
      L"\\StringFileInfo\\%04x%04x\\%s",
      translations[index].language,
      translations[index].codePage,
      key.c_str()
    );

    LPWSTR value = nullptr;
    UINT valueBytes = 0;
    if (VerQueryValueW(versionData.data(), queryPath, reinterpret_cast<LPVOID*>(&value), &valueBytes)
        && value != nullptr
        && valueBytes > sizeof(wchar_t)) {
      const std::wstring resolved = trim(std::wstring(value));
      if (!resolved.empty()) {
        return resolved;
      }
    }
  }

  return std::nullopt;
}

std::wstring getProcessAppName(DWORD processId) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (process == nullptr) {
    return L"";
  }

  std::wstring imagePath(MAX_PATH, L'\0');
  DWORD pathSize = static_cast<DWORD>(imagePath.size());
  if (!QueryFullProcessImageNameW(process, 0, imagePath.data(), &pathSize)) {
    CloseHandle(process);
    return L"";
  }

  imagePath.resize(pathSize);
  CloseHandle(process);

  if (const auto description = queryVersionString(imagePath, L"FileDescription")) {
    return *description;
  }

  return getBaseName(imagePath);
}

bool isWindowCloaked(HWND hwnd) {
  DWORD cloaked = 0;
  const HRESULT result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  return SUCCEEDED(result) && cloaked != 0;
}

bool hasCapturableBounds(HWND hwnd, RECT* outBounds) {
  RECT bounds{};
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)))) {
    if ((bounds.right - bounds.left) > 1 && (bounds.bottom - bounds.top) > 1) {
      *outBounds = bounds;
      return true;
    }
  }

  if (!GetWindowRect(hwnd, &bounds)) {
    return false;
  }

  if ((bounds.right - bounds.left) <= 1 || (bounds.bottom - bounds.top) <= 1) {
    return false;
  }

  *outBounds = bounds;
  return true;
}

bool endsWithCaseInsensitive(const std::wstring& value, const std::wstring& suffix) {
  if (suffix.empty() || value.size() < suffix.size()) {
    return false;
  }

  return _wcsicmp(value.c_str() + (value.size() - suffix.size()), suffix.c_str()) == 0;
}

bool isExcludedWindowTitle(const std::wstring& windowTitle) {
  static const std::vector<std::wstring> excludedTitles = {
    L"Backstop Window",
    L"DWM Notification Window",
    L"Input Occlusion Window",
    L"Windows Default Lock Screen",
  };

  return std::any_of(excludedTitles.begin(), excludedTitles.end(), [&](const std::wstring& excludedTitle) {
    return _wcsicmp(windowTitle.c_str(), excludedTitle.c_str()) == 0;
  });
}

std::wstring sanitizeWindowTitle(const std::wstring& windowTitle, const std::wstring& appName) {
  std::wstring sanitized = trim(windowTitle);
  if (sanitized.empty() || appName.empty()) {
    return sanitized;
  }

  const std::wstring emDashSuffix = L" — " + appName;
  if (endsWithCaseInsensitive(sanitized, emDashSuffix)) {
    sanitized.resize(sanitized.size() - emDashSuffix.size());
    return trim(sanitized);
  }

  const std::wstring hyphenSuffix = L" - " + appName;
  if (endsWithCaseInsensitive(sanitized, hyphenSuffix)) {
    sanitized.resize(sanitized.size() - hyphenSuffix.size());
    return trim(sanitized);
  }

  return sanitized;
}

bool shouldIncludeWindow(HWND hwnd) {
  if (!IsWindow(hwnd) || hwnd == GetShellWindow()) {
    return false;
  }

  if (GetAncestor(hwnd, GA_ROOT) != hwnd) {
    return false;
  }

  if (!IsWindowVisible(hwnd) && !IsIconic(hwnd)) {
    return false;
  }

  if (isWindowCloaked(hwnd)) {
    return false;
  }

  const LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if ((exStyle & WS_EX_TOOLWINDOW) != 0) {
    return false;
  }

  const std::wstring windowTitle = getWindowTextString(hwnd);
  if (windowTitle.empty() || isExcludedWindowTitle(windowTitle)) {
    return false;
  }

  RECT bounds{};
  return hasCapturableBounds(hwnd, &bounds);
}

std::string utf8FromWide(const std::wstring& wide) {
  if (wide.empty()) {
    return {};
  }

  const int utf8Length = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (utf8Length <= 1) {
    return {};
  }

  std::string utf8(static_cast<size_t>(utf8Length - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, utf8.data(), utf8Length, nullptr, nullptr);
  return utf8;
}

std::string jsonEscape(const std::wstring& wide) {
  const std::string utf8 = utf8FromWide(wide);
  std::string escaped;
  escaped.reserve(utf8.size() + 8);

  for (const unsigned char ch : utf8) {
    switch (ch) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buffer[7] = {};
          sprintf_s(buffer, "\\u%04x", ch);
          escaped += buffer;
        } else {
          escaped.push_back(static_cast<char>(ch));
        }
        break;
    }
  }

  return escaped;
}

BOOL CALLBACK enumWindowsCallback(HWND hwnd, LPARAM lParam) {
  auto* entries = reinterpret_cast<std::vector<WindowListEntry>*>(lParam);
  if (entries == nullptr || !shouldIncludeWindow(hwnd)) {
    return TRUE;
  }

  DWORD processId = 0;
  GetWindowThreadProcessId(hwnd, &processId);

  RECT bounds{};
  if (!hasCapturableBounds(hwnd, &bounds)) {
    return TRUE;
  }

  const std::wstring windowTitle = getWindowTextString(hwnd);
  const std::wstring appName = getProcessAppName(processId);
  const std::wstring resolvedWindowTitle = sanitizeWindowTitle(windowTitle, appName);
  const std::wstring fallbackName = !resolvedWindowTitle.empty() ? resolvedWindowTitle : (appName.empty() ? L"Window" : appName);
  const std::wstring combinedName = !appName.empty() && !resolvedWindowTitle.empty()
    ? appName + L" — " + resolvedWindowTitle
    : fallbackName;

  WindowListEntry entry;
  entry.id = L"window:" + std::to_wstring(static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(hwnd))) + L":0";
  entry.name = combinedName;
  entry.displayId = L"";
  entry.appName = appName;
  entry.windowTitle = resolvedWindowTitle.empty() ? fallbackName : resolvedWindowTitle;
  entry.bounds = bounds;
  entries->push_back(std::move(entry));

  return TRUE;
}

}  // namespace

int wmain() {
  std::vector<WindowListEntry> entries;
  entries.reserve(128);

  EnumWindows(enumWindowsCallback, reinterpret_cast<LPARAM>(&entries));

  std::sort(entries.begin(), entries.end(), [](const WindowListEntry& left, const WindowListEntry& right) {
    if (left.appName != right.appName) {
      return _wcsicmp(left.appName.c_str(), right.appName.c_str()) < 0;
    }

    return _wcsicmp(left.windowTitle.c_str(), right.windowTitle.c_str()) < 0;
  });

  std::cout << "[";
  for (size_t index = 0; index < entries.size(); ++index) {
    const auto& entry = entries[index];
    if (index > 0) {
      std::cout << ",";
    }

    std::cout
      << "{"
      << "\"id\":\"" << jsonEscape(entry.id) << "\","
      << "\"name\":\"" << jsonEscape(entry.name) << "\","
      << "\"display_id\":\"" << jsonEscape(entry.displayId) << "\","
      << "\"appName\":\"" << jsonEscape(entry.appName) << "\","
      << "\"windowTitle\":\"" << jsonEscape(entry.windowTitle) << "\","
      << "\"x\":" << entry.bounds.left << ","
      << "\"y\":" << entry.bounds.top << ","
      << "\"width\":" << (entry.bounds.right - entry.bounds.left) << ","
      << "\"height\":" << (entry.bounds.bottom - entry.bounds.top)
      << "}";
  }
  std::cout << "]";
  return 0;
}
