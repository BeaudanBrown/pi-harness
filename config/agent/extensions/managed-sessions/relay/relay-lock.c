#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int descriptor = open(argv[1], O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  if (descriptor < 0) return 1;
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    close(descriptor);
    return errno == EWOULDBLOCK ? 75 : 1;
  }
  if (fchmod(descriptor, 0600) != 0 || write(STDOUT_FILENO, "locked\n", 7) != 7) {
    close(descriptor);
    return 1;
  }
  char buffer[64];
  while (read(STDIN_FILENO, buffer, sizeof(buffer)) > 0) {}
  close(descriptor);
  return 0;
}
